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
