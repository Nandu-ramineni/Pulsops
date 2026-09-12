# Incident 001 — Database Slowdown

**Date:** 2026-09-12 · **Severity:** SEV-2 · **Status:** Resolved

## Scenario

Postgres backs both `user-service` and `order-service`. A real database
slowdown is usually resource contention, not the database being down —
this incident simulates that shape directly by CPU-throttling the Postgres
container rather than stopping it, so queries queue and slow down for real
instead of failing outright.

## Hypothesis

Under concurrent load, constraining Postgres to a fraction of a CPU core
will raise `db_query_duration_seconds` for every service that queries it,
which will propagate into gateway-level p95/p99 latency and, if severe
enough, cross the latency SLO's burn-rate thresholds.

## How to trigger

```bash
./scripts/inject-latency.sh db 0.05
# ... observe ...
./scripts/restore-latency.sh db
```

## Expected symptoms

Rising `db_query_duration_seconds`, rising gateway latency, possibly
`PostgresConnectionPoolSaturated` if queries queue faster than they
complete.

## Actual symptoms

Measured immediately before and ~45s after injection, under continuous
mixed load:

| Metric | Baseline | Under throttle (`--cpus=0.05`) |
|---|---|---|
| order-service DB query p95 | 5.0ms | **84.7ms** (17x) |
| user-service DB query p95 | ~5ms (unmeasured directly) | 39.3ms |
| Gateway p95 (all routes) | ~20ms (established baseline, Phase 9) | **910.2ms** (~45x) |
| `db_pool_connections{state="waiting"}` | 0 | **0** |

The pool-saturation prediction was wrong: connections never queued.
Throttling CPU makes each query individually slower without necessarily
exhausting the pool — a different failure shape than a connection leak or
a stuck transaction would produce, and `PostgresConnectionPoolSaturated`
correctly did not fire, because pool saturation was never the actual
problem here.

## Metrics

```promql
histogram_quantile(0.95, sum(rate(db_query_duration_seconds_bucket{service="order-service"}[2m])) by (le))
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service="gateway"}[2m])) by (le))
slo:latency:burn_rate5m   # 16.95 measured during the incident
```

## Logs

No error-level logs — this incident produces *slowness*, not failures.
`db_query_duration_seconds` moving is the only signal, which is itself a
finding: a slow dependency can be invisible to log-based alerting entirely
and only visible in latency histograms.

## Traces

A trace for any request during the window shows a proportionally longer
`pg.query` span relative to the pre-incident baseline traces from Phase 7 —
the same span name, ~17x the duration.

## Alert

Both tiers of the latency burn-rate alert fired during this incident's
active window, at different speeds:

| Alert | Delivered | MTTD (from 15:56:26 injection) |
|---|---|---|
| `LatencyErrorBudgetFastBurn` | 2026-09-12T16:00:57.939Z | **4m31.9s** |
| `LatencyErrorBudgetSlowBurn` | 2026-09-12T16:12:57.802Z | 16m31.8s — but see below |

## Detection time (MTTD)

**4m31.9s**, via the fast-burn tier — this is the number that matters,
since fast-burn is what actually paged.

The slow-burn tier's 16m31.8s figure is **not a second, independent
detection** — it is worth explaining precisely because it looks like one.
Postgres was restored at **16:07:06Z**, five minutes *before* slow-burn
fired. Slow-burn uses 6h/30m windows; the incident (10m40s of severe
latency) was still inside the 30-minute window when it finally crossed the
6x threshold, and inside the 6-hour window comfortably. **The alert that
looks like the second detection actually fired after the incident was
already resolved** — a real, demonstrated case of a slow-tier alert
lagging behind resolution rather than ahead of it. `LatencyErrorBudgetFastBurn`
itself resolved at the same moment slow-burn fired (16:12:57.808Z, one 5xxms
after) once its own 5m/1h windows cleared.

## Investigation

Incident Investigation dashboard → Latency p95/p99 panel showed the spike
immediately; Dependency Latency panel isolated it to Postgres specifically
(Redis and the downstream user-service call were both unaffected during
this window, confirming the throttle's blast radius was exactly what was
targeted).

## Root cause

Deliberately injected: `docker update --cpus=0.05` on the Postgres
container, simulating CPU contention (a noisy neighbor, an undersized
instance, or a runaway query on the same host in a real deployment).

## Mitigation

Remove the throttle: `docker update --cpus=0` (uncapped).

## Recovery

Restored at **16:07:06Z**. Gateway p95 returned toward baseline within the
next scrape interval; the 1m rolling window briefly still showed elevated
values immediately after restoration purely as a rolling-window artifact,
not ongoing impact — confirmed by a direct request roundtrip immediately
after restoration completing in single-digit milliseconds.

## MTTD / MTTR

```
MTTD = 16:00:57.939 − 15:56:26.000 = 4m31.9s   (fast-burn tier)
MTTR = 16:07:06.000 − 15:56:26.000 = 10m40s    (direct observation: injection to restoration)
```

No `resolved` MTTR is quoted from the fast-burn alert itself, because — as
above — it resolved *after* the slow-burn alert fired, well after the
actual fix, illustrating the same lagging-notification pattern as
Incident 2 but for a different structural reason (window contamination,
not batching).

## Classification

**SEV-2.** Every request got dramatically slower (P95 ~45x baseline) but
nothing failed outright — a major, real degradation of user experience
without an outage.

## Lessons learned

1. **A CPU throttle produces a genuinely different failure shape than a
   stopped or crashed dependency** — no errors, no pool saturation, just
   uniformly worse latency. An incident library needs more than one way to
   break the same dependency to exercise different alert paths.
2. **Multi-window burn-rate alerts can report events out of chronological
   order relative to the underlying incident.** A slow-tier alert firing
   after a fast-tier alert has already resolved is not a bug — it is two
   different windows looking at overlapping but distinct slices of history,
   and reading it as "detection improved" or "a new incident started" would
   be a misdiagnosis. The runbook and the alert's own annotation should be
   read for what the specific alert is measuring, not just its firing order.
