import 'dotenv/config';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { register, httpMetricsMiddleware } from './metrics.js';
import { logger, requestLoggingMiddleware } from './logger.js';

const app = express();
const PORT = process.env.PORT || 8080;

// Logging first so a correlation ID exists before anything else can fail,
// and so it's on req.headers by the time the proxy forwards downstream.
app.use(requestLoggingMiddleware);
app.use(httpMetricsMiddleware);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gateway' });
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// http-proxy-middleware logs to the console by default, which would put
// non-JSON lines into the log stream Loki collects. Route them through pino
// so every line the gateway emits is structured.
const proxyLogProvider = () => ({
  log: (msg) => logger.info({ component: 'proxy' }, msg),
  debug: (msg) => logger.debug({ component: 'proxy' }, msg),
  info: (msg) => logger.info({ component: 'proxy' }, msg),
  warn: (msg) => logger.warn({ component: 'proxy' }, msg),
  error: (msg) => logger.error({ component: 'proxy' }, msg),
});

// Path rewrite strips the /api prefix so downstream services keep their own
// simple route names (/users, /orders) independent of how the gateway exposes them.
function createServiceProxy({ target, from, to, upstream }) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: { [`^${from}`]: to },
    logProvider: proxyLogProvider,
    // Without this, an upstream that's down surfaces as an opaque socket
    // error with no correlation ID. Phase 14 kills services deliberately,
    // so this path needs to be observable.
    onError: (err, _req, res) => {
      logger.error({ err, upstream }, 'proxy request to upstream failed');
      if (!res.headersSent) {
        res.status(502).json({ error: 'upstream unavailable' });
      }
    },
  });
}

app.use(
  '/api/users',
  createServiceProxy({
    target: process.env.USER_SERVICE_URL,
    from: '/api/users',
    to: '/users',
    upstream: 'user-service',
  })
);

app.use(
  '/api/orders',
  createServiceProxy({
    target: process.env.ORDER_SERVICE_URL,
    from: '/api/orders',
    to: '/orders',
    upstream: 'order-service',
  })
);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'gateway listening');
});
