import 'dotenv/config';
import express from 'express';
import { query } from './db.js';
import usersRouter from './routes/users.js';
import { register, httpMetricsMiddleware } from './metrics.js';

const app = express();
const PORT = process.env.PORT || 4001;

app.use(express.json());
app.use(httpMetricsMiddleware);

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1', [], 'health_check');
    res.json({ status: 'ok', service: 'user-service' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', service: 'user-service', error: err.message });
  }
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use('/users', usersRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`user-service listening on ${PORT}`);
});
