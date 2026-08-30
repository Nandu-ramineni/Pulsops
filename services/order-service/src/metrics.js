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

export const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'PostgreSQL query duration in seconds',
  labelNames: ['operation', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const dbQueriesFailedTotal = new client.Counter({
  name: 'db_queries_failed_total',
  help: 'Total PostgreSQL queries that raised an error',
  labelNames: ['operation'],
  registers: [register],
});

export function registerDbPoolMetrics(pool) {
  // eslint-disable-next-line no-new
  new client.Gauge({
    name: 'db_pool_connections',
    help: 'PostgreSQL connection pool state',
    labelNames: ['state'],
    registers: [register],
    collect() {
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    },
  });
}

export const cacheHitsTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Cache lookups served from Redis',
  labelNames: ['cache'],
  registers: [register],
});

export const cacheMissesTotal = new client.Counter({
  name: 'cache_misses_total',
  help: 'Cache lookups that missed and fell through to origin',
  labelNames: ['cache'],
  registers: [register],
});

export const cacheErrorsTotal = new client.Counter({
  name: 'cache_errors_total',
  help: 'Redis operations that raised an error',
  labelNames: ['cache', 'operation'],
  registers: [register],
});

export const cacheOperationDuration = new client.Histogram({
  name: 'cache_operation_duration_seconds',
  help: 'Redis operation duration in seconds',
  labelNames: ['cache', 'operation'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [register],
});

// "Dependency" here means a call from this service to another one over the
// network (user-service), as distinct from a query to our own database -
// this is what answers "which downstream call is failing/slow" during an
// incident, separate from our own request handling.
export const dependencyRequestsTotal = new client.Counter({
  name: 'dependency_requests_total',
  help: 'Outbound calls to other services',
  labelNames: ['dependency', 'status'],
  registers: [register],
});

export const dependencyRequestDuration = new client.Histogram({
  name: 'dependency_request_duration_seconds',
  help: 'Outbound call duration in seconds',
  labelNames: ['dependency'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const queueMessagesPublishedTotal = new client.Counter({
  name: 'queue_messages_published_total',
  help: 'Messages published to RabbitMQ',
  labelNames: ['queue', 'status'],
  registers: [register],
});

export function httpMetricsMiddleware(req, res, next) {
  if (req.path === '/health' || req.path === '/metrics') return next();

  const start = process.hrtime.bigint();
  httpActiveRequests.inc();

  res.on('finish', () => {
    httpActiveRequests.dec();
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route ? `${req.baseUrl}${req.route.path}` : req.baseUrl || req.path;
    const labels = { method: req.method, route, status_code: res.statusCode };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSeconds);
  });

  next();
}
