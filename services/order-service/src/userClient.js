import { connectRedis } from './redisClient.js';
import { logger, getRequestId, REQUEST_ID_HEADER } from './logger.js';
import {
  cacheHitsTotal,
  cacheMissesTotal,
  cacheErrorsTotal,
  cacheOperationDuration,
  dependencyRequestsTotal,
  dependencyRequestDuration,
} from './metrics.js';

const TTL = Number(process.env.USER_CACHE_TTL_SECONDS || 60);
const CACHE_NAME = 'user_profile';
const REDIS_OP_TIMEOUT_MS = 750;

// Found during Incident 2 (Redis failure) fault injection: node-redis's
// default reconnectStrategy retries forever and never rejects, so
// `client.connect()` on a dead Redis hangs indefinitely rather than
// failing fast - a request awaiting it never times out on its own. Every
// Redis operation in this file is wrapped in this so a Redis outage costs
// at most REDIS_OP_TIMEOUT_MS, never "forever". This is what makes the
// cache-aside fallback actually graceful instead of just documented as such.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);
}

// Cache-aside: check Redis first, fall back to a live call to user-service on miss.
// This is the "OS -> Redis -> (miss) -> user-service" hop shown in the architecture diagram.
export async function getUser(userId) {
  const cacheKey = `user:${userId}`;
  const getTimer = cacheOperationDuration.startTimer({ cache: CACHE_NAME, operation: 'get' });

  // Redis is fully optional from here down: any failure to connect or read
  // - including a hang, bounded above - degrades to a cache miss rather
  // than failing the request. This is the fix for the bug above: the old
  // code rethrow on a GET failure, which meant "Redis is down" and "the
  // user doesn't exist" produced the same 500, and meant Redis being down
  // could fail every order-creation request despite the cache-aside design
  // intending otherwise.
  let redis;
  let cached = null;
  try {
    redis = await withTimeout(connectRedis(), REDIS_OP_TIMEOUT_MS, 'redis connect');
    cached = await withTimeout(redis.get(cacheKey), REDIS_OP_TIMEOUT_MS, 'redis get');
    getTimer();
  } catch (err) {
    getTimer();
    cacheErrorsTotal.inc({ cache: CACHE_NAME, operation: 'get' });
    logger.warn({ err, cache: CACHE_NAME, userId }, 'cache read failed, degrading to origin');
    redis = undefined;
  }

  if (cached) {
    cacheHitsTotal.inc({ cache: CACHE_NAME });
    logger.debug({ cache: CACHE_NAME, userId, outcome: 'hit' }, 'cache lookup');
    return { user: JSON.parse(cached), source: 'cache' };
  }
  cacheMissesTotal.inc({ cache: CACHE_NAME });
  logger.debug({ cache: CACHE_NAME, userId, outcome: 'miss' }, 'cache lookup');

  const depTimer = dependencyRequestDuration.startTimer({ dependency: 'user-service' });
  let response;
  try {
    // Forwarding the correlation ID is what lets one Loki query show this
    // request's log lines from order-service AND user-service together.
    const requestId = getRequestId();
    response = await fetch(`${process.env.USER_SERVICE_URL}/users/${userId}`, {
      headers: requestId ? { [REQUEST_ID_HEADER]: requestId } : {},
    });
  } catch (err) {
    depTimer();
    dependencyRequestsTotal.inc({ dependency: 'user-service', status: 'error' });
    logger.error({ err, dependency: 'user-service', userId }, 'dependency call failed');
    throw err;
  }
  depTimer();

  if (!response.ok) {
    dependencyRequestsTotal.inc({
      dependency: 'user-service',
      status: response.status >= 500 ? 'error' : 'client_error',
    });
    if (response.status === 404) return { user: null, source: 'origin' };
    throw new Error(`user-service returned ${response.status}`);
  }
  dependencyRequestsTotal.inc({ dependency: 'user-service', status: 'success' });

  const user = await response.json();

  // redis is undefined here if the get-side connect/read above already
  // failed - skip the write attempt entirely rather than trying (and
  // timing out) again on the same dead connection within one request.
  if (!redis) {
    return { user, source: 'origin' };
  }

  const setTimer = cacheOperationDuration.startTimer({ cache: CACHE_NAME, operation: 'set' });
  try {
    await withTimeout(redis.set(cacheKey, JSON.stringify(user), { EX: TTL }), REDIS_OP_TIMEOUT_MS, 'redis set');
    setTimer();
  } catch (err) {
    // A cache write failure shouldn't fail an otherwise-successful lookup -
    // count it and move on, the next request just misses again. Logged at
    // warn because silent degradation is exactly what makes the Redis
    // incident hard to spot.
    setTimer();
    cacheErrorsTotal.inc({ cache: CACHE_NAME, operation: 'set' });
    logger.warn({ err, cache: CACHE_NAME, userId }, 'cache write failed, continuing without caching');
  }

  return { user, source: 'origin' };
}
