const { createClient } = require('redis');

const client = createClient({ url: process.env.REDIS_URL });

client.on('error', (err) => {
  console.error('redis client error', err.message);
});

async function connectRedis() {
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}

module.exports = { client, connectRedis };
