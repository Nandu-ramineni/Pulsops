import { createClient } from 'redis';
import { logger } from './logger.js';

export const client = createClient({ url: process.env.REDIS_URL });

client.on('error', (err) => {
  logger.error({ err }, 'redis client error');
});

export async function connectRedis() {
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}
