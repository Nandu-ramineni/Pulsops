import 'dotenv/config';
import express from 'express';
import { pool } from './db.js';
import { connectRedis } from './redisClient.js';
import ordersRouter from './routes/orders.js';

const app = express();
const PORT = process.env.PORT || 4002;

app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    const redis = await connectRedis();
    await redis.ping();
    res.json({ status: 'ok', service: 'order-service' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', service: 'order-service', error: err.message });
  }
});

app.use('/orders', ordersRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`order-service listening on ${PORT}`);
});
