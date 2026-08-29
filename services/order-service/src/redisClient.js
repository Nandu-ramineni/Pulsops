import { createClient } from 'redis';

export const client = createClient({ url: process.env.REDIS_URL });

client.on('error', (err) => {
  console.error('redis client error', err.message);
});

export async function connectRedis() {
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}
