# Runbook: Dependency degraded

**Alerts:** `PostgresQueryFailures`, `PostgresConnectionPoolSaturated`,
`RedisErrors`, `DownstreamCallFailures`, `QueuePublishFailures`,
`WorkerProcessingFailures`, `QueueBacklogGrowing`

## Read this first

**None of these page, and that is deliberate.** Each describes a *cause*,
and a cause has not necessarily reached a user. The clearest example: the
user-profile lookup is cache-aside, so Redis can fail completely while every
single request still succeeds — just slower, with more load on Postgres.

This claim was actually **false** until Phase 14 fault injection caught it:
the original code rethrew on a Redis `GET` failure instead of falling
through, and node-redis's default reconnect strategy never gives up, so a
real outage could **hang requests indefinitely** rather than degrade
gracefully. Fixed in `userClient.js`/`redisClient.js` (bounded per-operation
timeouts, bounded reconnect attempts, fall-through-on-any-error) and
verified by actually breaking Redis again afterward — see
[incident-002-redis-failure](../../incidents/incident-002-redis-failure) for
the full before/after. The claim above is trustworthy now because it was
tested, not because it was designed that way from the start.

If users are actually being hurt, a burn-rate alert will page and one of
these will be sitting next to it as the explanation. If one of these fires
alone, you have advance warning, not an incident.

The exception worth watching: `QueuePublishFailures` and
`WorkerProcessingFailures` cause **silent data problems** rather than
errors. Orders stay `pending` forever. Nothing pages because nothing
user-facing fails, which makes these the most under-rated alerts here.

## Postgres

### `PostgresQueryFailures`
Queries are erroring. Check Postgres is up and accepting connections:

```bash
docker compose ps postgres
```

```bash
docker compose logs --tail 50 postgres
```

Which operation is failing:
```promql
sum by (service, operation) (rate(db_queries_failed_total[5m]))
```

### `PostgresConnectionPoolSaturated`
Requests are queued waiting for a connection. This shows up as **latency
long before it shows up as errors**, so it is an early warning.

```promql
db_pool_connections
```

`state="waiting"` above zero means demand exceeds the pool. Either the pool
is too small for the concurrency, or queries are slow enough to hold
connections too long — check which:

```promql
histogram_quantile(0.95, sum(rate(db_query_duration_seconds_bucket[5m])) by (le, operation))
```

Note `db_pool_connections` legitimately reads 0 when idle: `pg.Pool` closes
idle connections after ~10s. Zero is not evidence of a problem.

## Redis (`RedisErrors`)

Impact is indirect. Every miss falls through to user-service and Postgres,
so watch for the knock-on:

```promql
sum(rate(cache_hits_total[5m])) / (sum(rate(cache_hits_total[5m])) + sum(rate(cache_misses_total[5m])))
```

A collapsing hit ratio with rising Postgres latency is the real signal.
Cache *write* failures are logged at warn and swallowed deliberately — a
failed cache write must not fail an otherwise good request.

```bash
docker compose ps redis && docker compose logs --tail 50 redis
```

## Downstream calls (`DownstreamCallFailures`)

order-service cannot reach user-service. Only happens on a cache miss, so
current impact depends on the hit ratio above — a warm cache hides this
until entries expire.

If user-service is down, use [service-down.md](service-down.md).

## RabbitMQ

### `QueuePublishFailures`
Orders are written to Postgres and then never published. They stay `pending`
indefinitely. Check the AMQP connection:

```bash
docker compose logs --tail 50 order-service
```

The known failure mode is the connection being re-established in-band (see
`docs/slos.md`); a restart re-warms it:

```bash
docker compose restart order-service
```

### `WorkerProcessingFailures`
Messages are being nacked. **They are nacked without requeue, so they are
discarded, not retried** — those orders are lost from the pipeline. Check
what is failing:

```logql
{job="pulseops", service="worker", level="error"}
```

### `QueueBacklogGrowing`
Publish rate exceeds consume rate. This is a **derived proxy**, not true
queue depth — broker-native depth is unavailable since RabbitMQ moved to
CloudAMQP, so this can detect a *growing* backlog but not an existing one.

```promql
sum(rate(queue_messages_published_total{status="success"}[10m])) - sum(rate(queue_messages_consumed_total[10m]))
```

Diagnose in this order:
1. Is the worker alive? `up{job="worker"}`
2. Is it failing? `queue_messages_consumed_total{status="failed"}`
3. Is it slow? `queue_message_processing_duration_seconds` p95
4. Is its dependency slow? Worker Postgres latency on the Dependencies dashboard

That sequence distinguishes "worker is dead", "worker is erroring", "worker
is slow", and "worker's dependency is slow" — which need different fixes.

## Verify recovery

All of these should return to zero:

```promql
rate(db_queries_failed_total[5m])
rate(cache_errors_total[5m])
rate(dependency_requests_total{status="error"}[5m])
rate(queue_messages_published_total{status="error"}[5m])
rate(queue_messages_consumed_total{status="failed"}[5m])
```

For a queue backlog, confirm it is actually draining — consume rate must
exceed publish rate for a period, not merely match it.
