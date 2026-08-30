import client from 'prom-client';

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

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

// This is the "message processing rate / consumer failures" side of the
// RabbitMQ metrics called for in the project spec - queue depth itself is
// broker-native and comes from RabbitMQ's own Prometheus plugin instead,
// since depth is a property of the queue, not of any one consumer.
export const queueMessagesConsumedTotal = new client.Counter({
  name: 'queue_messages_consumed_total',
  help: 'Messages consumed from RabbitMQ, by outcome',
  labelNames: ['queue', 'status'],
  registers: [register],
});

export const queueMessageProcessingDuration = new client.Histogram({
  name: 'queue_message_processing_duration_seconds',
  help: 'Time to process one consumed message, including the DB write',
  labelNames: ['queue'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const workerActiveJobs = new client.Gauge({
  name: 'worker_active_jobs',
  help: 'Messages currently being processed (bounded by PREFETCH)',
  registers: [register],
});
