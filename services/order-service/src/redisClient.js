import { createClient } from 'redis';
import { logger } from './logger.js';

export const client = createClient({
  url: process.env.REDIS_URL,
  socket: {
    connectTimeout: 2000,
    // node-redis's default reconnectStrategy retries forever and never
    // rejects, which is what let a Redis outage hang requests indefinitely
    // instead of failing fast (found via fault injection - see
    // incidents/incident-002-redis-failure). Giving up after a handful of
    // attempts means client.connect() actually rejects, which is what lets
    // userClient.js's bounded timeout and cache-aside fallback work at all.
    reconnectStrategy(retries) {
      if (retries > 5) return new Error('redis reconnect attempts exhausted');
      return Math.min(retries * 100, 2000);
    },
  },
});

client.on('error', (err) => {
  logger.error({ err }, 'redis client error');
});

export async function connectRedis() {
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}
