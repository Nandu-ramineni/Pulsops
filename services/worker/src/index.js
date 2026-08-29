import 'dotenv/config';
import amqplib from 'amqplib';
import { pool } from './db.js';
import { startHealthServer, setReady } from './health.js';

const QUEUE_NAME = 'order.created';
const PREFETCH = Number(process.env.PREFETCH || 5);

// Simulates variable processing time so queue depth / consumer lag are
// visible under load once metrics land in Phase 4.
function simulateProcessing() {
  const delayMs = 200 + Math.random() * 800;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function updateOrderStatus(orderId, status) {
  await pool.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [status, orderId]);
}

// RabbitMQ's healthcheck can report "healthy" a moment before it actually
// accepts AMQP connections, so a single connect attempt at container startup
// is a real, observed race (not hypothetical) - retry with backoff instead
// of crashing on the first ECONNREFUSED.
async function connectWithRetry(url, { attempts = 10, baseDelayMs = 1000, maxDelayMs = 10000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await amqplib.connect(url);
    } catch (err) {
      if (attempt === attempts) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.error(`rabbitmq connect attempt ${attempt}/${attempts} failed (${err.message}), retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function main() {
  startHealthServer(process.env.HEALTH_PORT || 4003);

  const connection = await connectWithRetry(process.env.RABBITMQ_URL);
  const channel = await connection.createChannel();
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  channel.prefetch(PREFETCH);

  setReady(true);
  console.log(`worker consuming "${QUEUE_NAME}", prefetch=${PREFETCH}`);

  channel.consume(QUEUE_NAME, async (msg) => {
    if (!msg) return;
    let order;
    try {
      order = JSON.parse(msg.content.toString());
      await simulateProcessing();
      await updateOrderStatus(order.id, 'completed');
      console.log(`order ${order.id} completed`);
      channel.ack(msg);
    } catch (err) {
      console.error(`failed to process order ${order && order.id}`, err.message);
      channel.nack(msg, false, false);
    }
  });

  connection.on('close', () => {
    console.error('rabbitmq connection closed, exiting');
    setReady(false);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('worker failed to start', err);
  process.exit(1);
});
