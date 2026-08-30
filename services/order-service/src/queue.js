import amqplib from 'amqplib';
import { queueMessagesPublishedTotal } from './metrics.js';

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
    ch.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(order)), { persistent: true });
    queueMessagesPublishedTotal.inc({ queue: QUEUE_NAME, status: 'success' });
  } catch (err) {
    queueMessagesPublishedTotal.inc({ queue: QUEUE_NAME, status: 'error' });
    throw err;
  }
}
