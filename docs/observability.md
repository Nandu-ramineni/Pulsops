# Observability — Metrics (Phases 4-5)

Phase 4 instruments every service with Prometheus-format metrics via
`prom-client`, exposed on `/metrics`. Phase 5 (this section) stands up
Prometheus to scrape them and Grafana to visualize them.

## Why RED, and why it's not the whole picture

**RED = Rate, Errors, Duration.** Applied per HTTP endpoint:

- **Rate** — `http_requests_total` (a Counter). `rate(http_requests_total[5m])`
  in PromQL gives requests/sec.
- **Errors** — the `status_code` label on that same counter.
  `rate(http_requests_total{status_code=~"5.."}[5m])` gives the error rate
  without a second metric.
- **Duration** — `http_request_duration_seconds` (a Histogram).
  `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))`
  gives p95 latency.

RED is symptom-based: it measures what a caller of the service experiences,
not what the underlying box is doing. That's deliberate — see
[architecture.md §5](architecture.md) for why this project alerts on RED
(user-facing pain) rather than resource thresholds like `CPU > 80%`
(which correlate poorly with actual impact and are the single biggest
driver of alert fatigue).

But RED alone only tells you *that* a service is unhealthy, not *why*. So
every service also instruments its dependencies — the specific things that
can make its own RED numbers go bad:

| Service | Beyond RED, also measures | Why |
|---|---|---|
| user-service | Postgres query duration/failures, pool state | Only dependency it has |
| order-service | Postgres, Redis (hit/miss/latency/errors), the outbound call to user-service, RabbitMQ publish outcome | Touches all three dependency types — most incidents in Phase 14 center here |
| worker | Postgres, RabbitMQ consume outcome/duration, in-flight job count | Async path has no HTTP RED to lean on |
| gateway | RED only | It has no dependencies of its own — just proxies |

This is what makes the Phase 14 incident investigations possible: a p95
spike in the gateway's RED metrics tells you *something* is wrong; the
per-dependency metrics in order-service tell you *which* dependency.

## Metric dictionary

**Every HTTP service** (gateway, user-service, order-service):
- `http_requests_total{method, route, status_code}` — Counter
- `http_request_duration_seconds{method, route, status_code}` — Histogram
- `http_active_requests` — Gauge (in-flight count)
- Default Node.js process metrics (CPU, heap, event loop lag, GC) via
  `collectDefaultMetrics()` — not RED, but the USE-side data Dashboard 2's
  CPU/Memory rows need later.

**user-service, order-service, worker** (anything touching Postgres):
- `db_query_duration_seconds{operation, status}` — Histogram. `operation`
  is a hand-assigned label (`insert_user`, `get_order`, ...), not the raw
  SQL, to keep cardinality bounded.
- `db_queries_failed_total{operation}` — Counter
- `db_pool_connections{state="total"|"idle"|"waiting"}` — Gauge, read live
  from `pg.Pool` at scrape time via a custom `collect()` callback rather
  than tracked manually. Note: this reads `0` whenever no query has run in
  the last ~10s, because `pg.Pool`'s default `idleTimeoutMillis` closes
  unused connections — that's correct pool behavior, not a broken metric
  (verified directly: querying then immediately scraping shows
  `total=1, idle=1`).

**order-service only:**
- `cache_hits_total{cache}` / `cache_misses_total{cache}` — Counters
- `cache_errors_total{cache, operation}` — Counter
- `cache_operation_duration_seconds{cache, operation}` — Histogram
- `dependency_requests_total{dependency, status}` — Counter (the call to
  user-service on a cache miss)
- `dependency_request_duration_seconds{dependency}` — Histogram
- `queue_messages_published_total{queue, status}` — Counter

**worker only:**
- `queue_messages_consumed_total{queue, status="completed"|"failed"}` — Counter
- `queue_message_processing_duration_seconds{queue}` — Histogram
- `worker_active_jobs` — Gauge (bounded by `PREFETCH`)

**RabbitMQ queue depth** is deliberately *not* an application metric.
Queue depth is a property of the broker, not any one producer or consumer,
so it comes from RabbitMQ's own Prometheus plugin
(`observability/rabbitmq/enabled_plugins` enables `rabbitmq_prometheus`,
exposed on `:15692`) — verified under a 150-order burst: depth climbed to
65+ in-flight messages and drained back to 0 as the worker caught up.

## Design decisions worth knowing

- **`/health` and `/metrics` are excluded from the RED counters.** They're
  infra traffic (Docker healthchecks, the future Prometheus scraper), not
  user-facing requests — counting them would dilute the actual RED signal.
- **Route labels are bounded, not raw paths.** `/users/1`, `/users/2`, ...
  would each become a distinct Prometheus time series (cardinality
  explosion) if the middleware used `req.path`. Instead it uses
  `req.route.path` prefixed with `req.baseUrl` (e.g. `/users/:id`), which
  Express only populates after route matching. The gateway has no Express
  Router (just proxy middleware mounted by prefix), so it falls back to
  `req.baseUrl` (`/api/users`, `/api/orders`) — still bounded.
- **`operation` labels on DB metrics are hand-assigned strings**
  (`insert_order`, `get_user`, ...), not the SQL text, for the same
  cardinality reason.

## Verifying the raw metrics yourself

```bash
curl http://localhost:7000/metrics   # gateway
curl http://localhost:4001/metrics   # user-service
curl http://localhost:4002/metrics   # order-service
curl http://localhost:4003/metrics   # worker
curl http://localhost:15692/metrics  # RabbitMQ broker metrics
```

## Prometheus & Grafana (Phase 5)

Prometheus (`observability/prometheus/prometheus.yml`) scrapes all five
targets above every 10s and stores the time series. Grafana is provisioned
automatically on startup — datasource and dashboards are files in
`observability/grafana/`, not clicked together in the UI, so the whole
observability stack is reproducible from a fresh `docker compose up`.

**Access:**
- Prometheus UI: http://localhost:9200 (mapped from the container's 9090 —
  same Hyper-V/WSL port-exclusion issue as the gateway, see the README)
- Grafana: http://localhost:3000 (admin/admin, or just browse anonymously —
  anonymous Viewer access is enabled for convenience in this local dev
  setup only)

**Two dashboards shipped this phase**, both auto-provisioned:
- **Service Overview** (`service-overview.json`) — Request Rate, Error
  Rate, p50/p95/p99 Latency, Active Requests, CPU, Memory. Has a
  `$service` template variable (gateway / user-service / order-service —
  worker has no HTTP surface, so it's naturally excluded since the
  variable is populated from `label_values(http_requests_total, service)`).
- **Dependencies** (`dependencies.json`) — Postgres query duration and
  pool state, Redis hit ratio and latency, the order-service→user-service
  dependency call latency, RabbitMQ queue depth, worker processing rate.

**Two dashboards from the original spec are deliberately not built yet:**
Executive Reliability Overview needs error budget/SLO/MTTD/MTTR data that
doesn't exist until Phases 9-13; Incident Investigation needs log and trace
panels that don't exist until Phases 6-7. Building them now would mean
empty or fake panels — they land when the data backing them is real.

**A cosmetic bug found and fixed while verifying panels in the browser:**
the Error Rate panel's y-axis auto-scaled to 10000% when every service's
error rate was flat at 0 (an idle Prometheus query result set still
produces valid data, so this wasn't a "no data" case — Grafana just picked
an odd auto-range for a zero-variance series). Fixed by pinning
`min: 0, max: 1` on that panel instead of leaving the axis to auto-scale.
This is why every dashboard here was actually opened and screenshotted
during this phase, not just checked via the Prometheus query API — a
query returning the right numbers doesn't guarantee the panel renders
sensibly.

## Interview Questions This Phase Should Prepare You For

1. "Why a Histogram instead of tracking min/max/avg latency?" — Histograms
   let you compute *any* quantile after the fact via
   `histogram_quantile()`, across any time window, without having
   pre-decided which percentile matters. Averages hide tail latency
   entirely; a Histogram's bucketed counts don't.
2. "Why not just alert on CPU/memory?" — Resource usage doesn't map
   reliably to user impact. A service can run hot on CPU and serve every
   request fine, or sit at 10% CPU while every request times out on a
   downstream lock. RED (or its request/dependency-aware relatives)
   measures the thing you actually care about.
3. "How do you keep Prometheus label cardinality under control?" — Never
   put an unbounded value (user ID, raw path, timestamp) in a label. Use
   route templates and hand-assigned operation names, as done throughout
   this phase.
4. "Why is queue depth a broker metric and not something the worker
   reports?" — The worker only knows what it has consumed; it has no
   visibility into what's still sitting in the queue, especially with
   multiple producers/consumers. That number only exists in one place: the
   broker itself.
5. "Why provision Grafana from files instead of building dashboards in the
   UI?" — A dashboard built by hand in the UI lives only in that one
   Grafana instance's database; it's not reviewable in a PR, not
   reproducible on a fresh environment, and easy to accidentally edit
   during an incident. File-based provisioning (`observability/grafana/`)
   makes the dashboard itself a versioned artifact.
6. "Why not build all four dashboards from the spec right away?" — Two of
   them (Executive Overview, Incident Investigation) depend on data that
   doesn't exist until later phases (SLOs/error budgets, logs/traces).
   Building the panels now would mean shipping something that either shows
   nothing or has to be faked — building incrementally as each data source
   comes online avoids both.
