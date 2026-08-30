import { connectRedis } from './redisClient.js';
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

// Cache-aside: check Redis first, fall back to a live call to user-service on miss.
// This is the "OS -> Redis -> (miss) -> user-service" hop shown in the architecture diagram.
export async function getUser(userId) {
  const redis = await connectRedis();
  const cacheKey = `user:${userId}`;

  const getTimer = cacheOperationDuration.startTimer({ cache: CACHE_NAME, operation: 'get' });
  let cached;
  try {
    cached = await redis.get(cacheKey);
    getTimer();
  } catch (err) {
    getTimer();
    cacheErrorsTotal.inc({ cache: CACHE_NAME, operation: 'get' });
    throw err;
  }

  if (cached) {
    cacheHitsTotal.inc({ cache: CACHE_NAME });
    return { user: JSON.parse(cached), source: 'cache' };
  }
  cacheMissesTotal.inc({ cache: CACHE_NAME });

  const depTimer = dependencyRequestDuration.startTimer({ dependency: 'user-service' });
  let response;
  try {
    response = await fetch(`${process.env.USER_SERVICE_URL}/users/${userId}`);
  } catch (err) {
    depTimer();
    dependencyRequestsTotal.inc({ dependency: 'user-service', status: 'error' });
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

  const setTimer = cacheOperationDuration.startTimer({ cache: CACHE_NAME, operation: 'set' });
  try {
    await redis.set(cacheKey, JSON.stringify(user), { EX: TTL });
    setTimer();
  } catch (err) {
    // A cache write failure shouldn't fail an otherwise-successful lookup -
    // count it and move on, the next request just misses again.
    setTimer();
    cacheErrorsTotal.inc({ cache: CACHE_NAME, operation: 'set' });
  }

  return { user, source: 'origin' };
}
