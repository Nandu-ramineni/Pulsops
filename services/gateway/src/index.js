import 'dotenv/config';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { register, httpMetricsMiddleware } from './metrics.js';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(httpMetricsMiddleware);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gateway' });
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Path rewrite strips the /api prefix so downstream services keep their own
// simple route names (/users, /orders) independent of how the gateway exposes them.
app.use(
  '/api/users',
  createProxyMiddleware({
    target: process.env.USER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/users': '/users' },
  })
);

app.use(
  '/api/orders',
  createProxyMiddleware({
    target: process.env.ORDER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/orders': '/orders' },
  })
);

app.listen(PORT, () => {
  console.log(`gateway listening on ${PORT}`);
});
