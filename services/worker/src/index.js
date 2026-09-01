import 'dotenv/config';
import amqplib from 'amqplib';
import { query } from './db.js';
import { startHealthServer, setReady } from './health.js';
import { queueMessagesConsumedTotal, queueMessageProcessingDuration, workerActiveJobs } from './metrics.js';
import { logger, requestContext } from './logger.js';

const QUEUE_NAME = 'order.created';
const PREFETCH = Number(process.env.PREFETCH || 5);

// Simulates variable processing time so queue depth / consumer lag are
// visible under load once metrics land in Phase 4.
function simulateProcessing() {
  const delayMs = 200 + Math.random() * 800;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function updateOrderStatus(orderId, status) {
  await query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [status, orderId], 'update_order_status');
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
      logger.warn({ err, attempt, attempts, retryInMs: delay }, 'rabbitmq connect failed, retrying');
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
  logger.info({ queue: QUEUE_NAME, prefetch: PREFETCH }, 'worker consuming');

  channel.consume(QUEUE_NAME, async (msg) => {
    if (!msg) return;
    // The correlation ID rode across the queue on the AMQP correlationId
    // property, so reopening the context here puts the worker's log lines
    // in the same Loki query as the HTTP request that created the order -
    // across an async boundary the HTTP header alone could not cross.
    const requestId = msg.properties?.correlationId;

    await requestContext.run({ requestId }, async () => {
      let order;
      workerActiveJobs.inc();
      const endTimer = queueMessageProcessingDuration.startTimer({ queue: QUEUE_NAME });
      try {
        order = JSON.parse(msg.content.toString());
        await simulateProcessing();
        await updateOrderStatus(order.id, 'completed');
        queueMessagesConsumedTotal.inc({ queue: QUEUE_NAME, status: 'completed' });
        logger.info({ orderId: order.id, queue: QUEUE_NAME }, 'order processed');
        channel.ack(msg);
      } catch (err) {
        queueMessagesConsumedTotal.inc({ queue: QUEUE_NAME, status: 'failed' });
        logger.error({ err, orderId: order?.id, queue: QUEUE_NAME }, 'failed to process order');
        channel.nack(msg, false, false);
      } finally {
        endTimer();
        workerActiveJobs.dec();
      }
    });
  });

  connection.on('close', () => {
    logger.error('rabbitmq connection closed, exiting');
    setReady(false);
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
