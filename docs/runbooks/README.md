# Runbooks

An alert that says only "something is wrong" costs the responder minutes
they do not have. Every alert rule in
`observability/prometheus/rules/alerts.yml` carries a `runbook_url`
annotation pointing into this directory.

## What pages, and what does not

PulseOps deliberately pages on **symptoms**, not causes.

| Alert | Severity | Wakes someone? |
|---|---|---|
| `AvailabilityErrorBudgetFastBurn` | critical | **yes** |
| `AvailabilityErrorBudgetSlowBurn` | critical | **yes** |
| `LatencyErrorBudgetFastBurn` | critical | **yes** |
| `LatencyErrorBudgetSlowBurn` | critical | **yes** |
| `ServiceDown` | critical | **yes** |
| `AvailabilityErrorBudgetDrain` | warning | no — ticket |
| `LatencyErrorBudgetDrain` | warning | no — ticket |
| `NoTrafficReceived` | warning | no — ticket |
| `PostgresQueryFailures` | warning | no — ticket |
| `PostgresConnectionPoolSaturated` | warning | no — ticket |
| `RedisErrors` | warning | no — ticket |
| `DownstreamCallFailures` | warning | no — ticket |
| `QueuePublishFailures` | warning | no — ticket |
| `WorkerProcessingFailures` | warning | no — ticket |
| `QueueBacklogGrowing` | warning | no — ticket |

Five alerts can wake a human. Everything else exists to *explain* an
incident, not to start one. A cause-based alert firing on its own often
means nothing reached the user — Redis can fail completely while every
request still succeeds through the cache-aside fallback.

Routing (which receiver each alert reaches, based on its `notify` label),
grouping, inhibition (suppressing a redundant lower-severity duplicate of
an already-firing alert), and silencing (for planned maintenance) are all
handled by Alertmanager — see [docs/alerting.md](../alerting.md#alertmanager-phase-12)
for how, verified against real webhook deliveries rather than assumed from
the config. Alertmanager's own UI is at http://localhost:9093; delivered
notifications are inspectable at http://localhost:4004/alerts.

## Runbooks

- **[slo-burn-rate.md](slo-burn-rate.md)** — all four burn-rate pages
- **[service-down.md](service-down.md)** — `ServiceDown`
- **[dependency-degraded.md](dependency-degraded.md)** — the dependency
  warning family (Postgres, Redis, RabbitMQ, downstream calls)

Per-failure-mode runbooks tied to the reproducible incidents
(`incidents/incident-00N-*`) are written in Phase 16, once each failure has
actually been simulated and measured in Phase 14. Writing them before
running the incident would mean inventing the symptoms.

For the overall process a firing alert triggers — severity levels
(SEV-1..4), the full detection-to-postmortem lifecycle, roles, and the
exact MTTD/MTTR definitions Phase 14 measures against — see
[docs/incident-response.md](../incident-response.md).

## Where to look, in order

1. **[Incident Investigation dashboard](http://localhost:3000/d/pulseops-incident-investigation)**
   — service up/down, error rate, latency, dependency health, and the error
   logs, laid out in that order deliberately.
2. **[Executive Reliability Overview](http://localhost:3000/d/pulseops-executive-reliability)**
   — how much error budget this is costing.
3. **Logs** — Grafana Explore, Loki datasource:
   `{job="pulseops", level=~"warn|error"}`
4. **Traces** — expand a log line, click **TraceID → View trace**, or search
   Tempo directly with `{duration > 1s}` to find slow requests.
