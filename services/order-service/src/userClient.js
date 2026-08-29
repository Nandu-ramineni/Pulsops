import { connectRedis } from './redisClient.js';

const TTL = Number(process.env.USER_CACHE_TTL_SECONDS || 60);

// Cache-aside: check Redis first, fall back to a live call to user-service on miss.
// This is the "OS -> Redis -> (miss) -> user-service" hop shown in the architecture diagram.
export async function getUser(userId) {
  const redis = await connectRedis();
  const cacheKey = `user:${userId}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return { user: JSON.parse(cached), source: 'cache' };
  }

  const response = await fetch(`${process.env.USER_SERVICE_URL}/users/${userId}`);
  if (!response.ok) {
    if (response.status === 404) return { user: null, source: 'origin' };
    throw new Error(`user-service returned ${response.status}`);
  }
  const user = await response.json();
  await redis.set(cacheKey, JSON.stringify(user), { EX: TTL });
  return { user, source: 'origin' };
}
