import 'dotenv/config';
import express from 'express';
import { query } from './db.js';
import { connectRedis } from './redisClient.js';
import ordersRouter from './routes/orders.js';
import { register, httpMetricsMiddleware } from './metrics.js';

const app = express();
const PORT = process.env.PORT || 4002;

app.use(express.json());
app.use(httpMetricsMiddleware);

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1', [], 'health_check');
    const redis = await connectRedis();
    await redis.ping();
    res.json({ status: 'ok', service: 'order-service' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', service: 'order-service', error: err.message });
  }
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use('/orders', ordersRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`order-service listening on ${PORT}`);
});
