import client from 'prom-client';

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests received',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpActiveRequests = new client.Gauge({
  name: 'http_active_requests',
  help: 'HTTP requests currently being processed',
  registers: [register],
});

// The gateway is the single entry point, so its RED metrics are the closest
// thing this system has to "what the user actually experiences" - this is
// the signal Dashboard 1 (executive overview) and burn-rate alerts key off
// of in later phases, not any one backend service's own view of itself.
// There's no req.route here (no Router, just proxy middleware mounted by
// path prefix), so req.baseUrl is the route label - bounded to /api/users,
// /api/orders, and /health rather than per-ID paths.
export function httpMetricsMiddleware(req, res, next) {
  if (req.path === '/health' || req.path === '/metrics') return next();

  const start = process.hrtime.bigint();
  httpActiveRequests.inc();

  res.on('finish', () => {
    httpActiveRequests.dec();
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.baseUrl || req.path;
    const labels = { method: req.method, route, status_code: res.statusCode };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSeconds);
  });

  next();
}
