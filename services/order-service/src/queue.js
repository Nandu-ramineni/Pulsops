import amqplib from 'amqplib';

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
  const ch = await connectQueue();
  ch.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(order)), { persistent: true });
}
