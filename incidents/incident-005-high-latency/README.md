# Incident 005 — High Latency

**Date:** 2026-09-12 · **Severity:** SEV-2 · **Status:** Resolved

## Scenario

Not every latency incident is a database problem (that's Incident 001) —
sometimes the service itself is slow, independent of any dependency. This
simulates that shape directly via a controlled, code-level fault injection
rather than an external cause, isolating "the service is slow" from "a
dependency is slow."

## Hypothesis

A fixed artificial delay added to every `/orders` request will move p95
latency by roughly that fixed amount, cross the latency SLO's 250ms
threshold on effectively 100% of order-creation traffic, and trigger the
fast-burn latency alert within a similar timeframe to Incident 001's
fast-burn (both are ~100%-affected-traffic scenarios).

## How to trigger

```bash
./scripts/inject-latency.sh dependency 700
# ... observe ...
./scripts/restore-latency.sh dependency
```

Implemented as `ARTIFICIAL_LATENCY_MS`, a feature flag in
`services/order-service/src/index.js` — a no-op unless set, scoped to
`/orders` only (not `/health`, so Docker's own health check isn't also
casualty of the injected fault, matching how real fault-injection tooling
separates "the request is slow" from "the process is broken").

## Expected symptoms

Gateway p95/p99 for `/api/orders` rises by ~700ms; `LatencyErrorBudgetFastBurn`
fires; no error rate impact, since the endpoint still succeeds, just slowly.

## Actual symptoms

| | Before | During (700ms injected) | After |
|---|---|---|---|
| `POST /api/orders` p95 | 87.9ms | — | — |
| Single-request roundtrip | — | 753ms (700ms + ~53ms base) | 164ms |

The injection was exactly as designed: 700ms landed as ~750ms end-to-end,
consistently, and reverting it dropped straight back to baseline in the
very next request — a controlled, reversible fault behaving exactly as
built, unlike Incidents 001/002/004 which each surfaced something the
design didn't anticipate.

## Metrics

```promql
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service="gateway",route="/api/orders"}[2m])) by (le))
slo:latency:burn_rate5m
```

## Logs

```logql
{job="pulseops", service="order-service", level="warn"} | json | message="ARTIFICIAL_LATENCY_MS active - fault injection enabled"
```
Logged once at startup specifically so a fault-injection run is
unambiguous in the log stream — anyone reading logs from this window sees
immediately that a deliberate experiment was in progress, not a real fault.

## Traces

Every span for `/orders` during this window shows the artificial delay as
literal wall-clock time inside the request handler span — visible and
attributable directly, unlike Incident 001 where the delay showed up
several spans deep inside `pg.query`.

## Alert

`LatencyErrorBudgetFastBurn`. Delivered **2026-09-12T16:20:27.771Z**.

## Detection time (MTTD)

```
MTTD = 16:20:27.771 − 16:15:52.000 = 4m35.8s
```

Nearly identical to Incident 001's fast-burn MTTD (4m31.9s) — expected,
since both incidents affect close to 100% of one route's traffic and the
alert's mechanics don't distinguish *why* a request was slow.

## Investigation

Same dashboard path as Incident 001 (Latency panel first), but the
Dependency Latency panel this time showed **no** corresponding rise in
Postgres, Redis, or downstream-call latency — correctly pointing at the
service itself rather than a dependency, which is precisely the
distinction this incident exists to demonstrate.

## Root cause

Deliberately injected via `ARTIFICIAL_LATENCY_MS=700`.

## Mitigation

Clear the environment variable and redeploy:
`docker compose up -d order-service` with `ARTIFICIAL_LATENCY_MS` unset.

## Recovery

Restored at **16:23:19Z**; healthy and verified at **16:23:25Z**. A test
request immediately after returned in 164ms.

## MTTD / MTTR

```
MTTD = 16:20:27.771 − 16:15:52.000 = 4m35.8s
MTTR = 16:23:25.000 − 16:20:27.771 = 2m57.2s   (alert fired -> service restarted and confirmed healthy)
```

## Classification

**SEV-2.** A fixed, moderate latency increase on one endpoint — real
degradation, no outright failures, and only one route affected.

## Lessons learned

1. **A feature-flagged fault injection point, built once, is reusable
   indefinitely** — this is now a standing capability (`ARTIFICIAL_LATENCY_MS`),
   not a one-off script, and costs nothing when off.
2. **Comparing this incident's clean, exactly-as-designed behavior against
   Incidents 001/002/004's surprises is itself informative**: a fault you
   inject at the application layer, in code you control, behaves exactly
   as designed. Faults that cross a real boundary (CPU scheduling, a
   client library's retry logic, a metric that lives on another process)
   are where the actual surprises live. Both kinds of testing earn their
   place in an incident library for different reasons.
