import 'dotenv/config';
import express from 'express';
import { query } from './db.js';
import usersRouter from './routes/users.js';
import { register, httpMetricsMiddleware } from './metrics.js';
import { logger, requestLoggingMiddleware } from './logger.js';

const app = express();
const PORT = process.env.PORT || 4001;

// Logging first so a correlation ID exists before anything else can fail.
app.use(requestLoggingMiddleware);
app.use(express.json());
app.use(httpMetricsMiddleware);

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1', [], 'health_check');
    res.json({ status: 'ok', service: 'user-service' });
  } catch (err) {
    // Logged (not silently returned) so a dependency outage is visible in
    // Loki during an incident, not only to whoever curls /health.
    logger.warn({ err }, 'health check failed');
    res.status(503).json({ status: 'unhealthy', service: 'user-service', error: err.message });
  }
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use('/users', usersRouter);

app.use((err, _req, res, _next) => {
  // express.json() raises a SyntaxError carrying status 400 for a malformed
  // body. Flattening every error to 500 would let a client's bad payload
  // burn the error budget and page someone - the SLO and burn-rate alerts
  // in Phases 9-12 key off 5xx specifically.
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    logger.error({ err }, 'unhandled error in request pipeline');
    return res.status(500).json({ error: 'internal error' });
  }

  logger.warn({ err, statusCode: status }, 'request rejected as client error');
  return res.status(status).json({ error: 'invalid request' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'user-service listening');
});
