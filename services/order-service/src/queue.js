import amqplib from 'amqplib';
import { queueMessagesPublishedTotal } from './metrics.js';
import { logger, getRequestId } from './logger.js';

export const QUEUE_NAME = 'order.created';
let channel;

export async function connectQueue() {
  if (channel) return channel;
  const connection = await amqplib.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  return channel;
}

// Establish the AMQP connection at startup instead of lazily inside the first
// order. Distributed tracing showed the first request after any restart paying
// the full CloudAMQP TLS + AMQP handshake in-band: 3.40s versus ~0.02s once
// warm, reproducible across restarts. That is one multi-second latency outlier
// per deploy, which would otherwise contaminate the SLO baseline in Phase 9.
//
// Deliberately non-blocking and failure-tolerant: the service must still start
// (and serve reads) when the broker is unreachable, and publishOrderCreated
// still falls back to connecting on demand.
export function warmQueueConnection() {
  connectQueue()
    .then(() => logger.info({ queue: QUEUE_NAME }, 'amqp connection established at startup'))
    .catch((err) => logger.warn({ err }, 'could not pre-establish amqp connection, will connect on first publish'));
}

export async function publishOrderCreated(order) {
  try {
    const ch = await connectQueue();
    // correlationId is a standard AMQP message property, so the correlation
    // ID rides the protocol rather than being stuffed into the payload -
    // this is what carries it across the async boundary to the worker.
    ch.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(order)), {
      persistent: true,
      correlationId: getRequestId(),
    });
    queueMessagesPublishedTotal.inc({ queue: QUEUE_NAME, status: 'success' });
    logger.info({ queue: QUEUE_NAME, orderId: order.id }, 'published order.created');
  } catch (err) {
    queueMessagesPublishedTotal.inc({ queue: QUEUE_NAME, status: 'error' });
    logger.error({ err, queue: QUEUE_NAME, orderId: order.id }, 'failed to publish order.created');
    throw err;
  }
}
