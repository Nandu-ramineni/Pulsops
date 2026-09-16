# Postmortem: High Latency

## Incident Summary

A 700ms artificial delay injected directly into `order-service`'s
`/orders` handler (via a feature flag, `ARTIFICIAL_LATENCY_MS`) raised p95
by roughly that amount, paged the latency fast-burn alert, and reverted
cleanly to baseline the instant the flag was cleared. Included in this
project's incident library specifically as the control case: a fault
injected at the application layer, in code under direct control, behaving
exactly as designed — a useful contrast against the other four incidents,
each of which surfaced something the design didn't anticipate.

## Severity

**SEV-2** — a fixed, moderate latency increase on one endpoint: real
degradation, no outright failures, only one route affected. Per the
[severity table](../incident-response.md#severity-levels): "a significant
subset of users or one full capability is broken, but the system is not
entirely down."

## Impact

`POST /api/orders` p95 rose from an 87.9ms baseline to a single-request
roundtrip of **753ms** during the injection (700ms injected + ~53ms base)
— consistently, for the duration of the injection. No error-rate impact:
the endpoint still succeeded on every request, just slowly. Reverting the
flag dropped latency straight back to baseline (164ms) on the very next
request.

## Timeline

All times UTC.

| Time (UTC) | Event |
|---|---|
| 16:15:52.000 | Failure injected — `ARTIFICIAL_LATENCY_MS=700` set and order-service redeployed |
| 16:20:27.771 | `LatencyErrorBudgetFastBurn` reached `firing` |
| 16:20:27.771 | Investigation started (paged by the alert) |
| 16:20:27.771 (near-immediate) | Root cause identified — a controlled injection, known in advance; the Dependency Latency panel confirmed no rise in any actual dependency (Postgres, Redis, downstream call), correctly pointing at the service itself |
| 16:23:19.000 | Mitigation applied — environment variable cleared, order-service redeployed |
| 16:23:25.000 | Service confirmed healthy; a test request immediately returned in 164ms |
| 16:23:25.000 | Incident closed |

## Detection

`LatencyErrorBudgetFastBurn` (page tier). Delivered 16:20:27.771Z — nearly
identical to [Incident 001's](2026-09-12-database-slowdown.md) fast-burn
MTTD (4m31.9s), which makes sense: both incidents affect close to 100% of
one route's traffic, and the alert's mechanics don't distinguish *why* a
request was slow, only that it was. The Incident Investigation dashboard's
Dependency Latency panel showed **no** corresponding rise in Postgres,
Redis, or the downstream user-service call — correctly pointing at the
service itself rather than a dependency, the exact distinction this
incident exists to demonstrate.

## Root Cause

Deliberately injected via `ARTIFICIAL_LATENCY_MS=700`, a feature flag in
`services/order-service/src/index.js` — a no-op unless set, scoped to
`/orders` only (not `/health`, so Docker's own health check wasn't also a
casualty of the injected fault, mirroring how real fault-injection tooling
separates "the request is slow" from "the process is broken").

## Contributing Factors

None — this is the control case specifically because nothing about it
surprised the design. The fault is entirely application-layer, in code
under direct control, and behaved exactly as built.

## Resolution

Mitigation and fix were the same action: clearing the
`ARTIFICIAL_LATENCY_MS` environment variable and redeploying
(`docker compose up -d order-service`). Latency returned to baseline on
the very first request after redeploy — no gradual recovery, no lingering
effect, unlike the AMQP warm-up behavior noted elsewhere in this project
where a fix landing and its effect showing in metrics are two different
moments.

## MTTD

```text
MTTD = 16:20:27.771 − 16:15:52.000
     = 4m35.8s
```

## MTTR

```text
MTTR = 16:23:25.000 − 16:20:27.771
     = 2m57.2s   (alert fired → service redeployed and confirmed healthy)
```

## What Went Well

- The injection behaved exactly as designed: ~700ms landed as ~753ms
  end-to-end, consistently, and reverting it dropped straight back to
  baseline on the very next request — no residual effect to chase.
- The Dependency Latency panel correctly ruled out every actual
  dependency, pointing at the service itself immediately — the intended
  demonstration of this incident.
- Every span for `/orders` during the window showed the artificial delay
  as literal wall-clock time directly inside the request-handler span,
  visible and attributable at a glance, unlike Incident 001 where the
  delay showed up several spans deep inside `pg.query`.
- A dedicated startup log line
  (`"ARTIFICIAL_LATENCY_MS active - fault injection enabled"`) made this
  window unambiguous as a deliberate experiment to anyone reading logs
  from it later, rather than looking like an unexplained real incident.

## What Went Poorly

Nothing distinct to this incident — it is reported here specifically
because it worked as intended, and that itself is informative alongside
the other four incidents in this project's library, each of which found
something the design didn't anticipate. A fault injected at the
application layer, in code you control, behaves exactly as designed;
faults that cross a real boundary (CPU scheduling, a client library's
retry logic, a metric that lives on another process) are where the actual
surprises live.

## Lessons Learned

1. A feature-flagged fault injection point, built once, is reusable
   indefinitely — `ARTIFICIAL_LATENCY_MS` is now a standing capability,
   not a one-off script, and costs nothing when off.
2. Comparing this incident's clean, exactly-as-designed behavior against
   Incidents 001/002/004's surprises is itself a useful finding: both
   kinds of testing (application-layer fault injection, and breaking a
   real external boundary) earn a place in an incident library, for
   different reasons — one validates the alerting and rollback mechanics
   cleanly, the other finds real defects.

## Action Items

| Action | Owner | Priority |
|---|---|---|
| None generated by this incident specifically — it validated existing mechanics rather than finding a defect. See Incidents 001/002/003/004 for the action items this project's incident library actually produced. | — | — |

This incident's 5-minute latency burn rate was not separately recorded in
the source incident data beyond the alert firing itself; no error-budget
calculation is reported here rather than estimating one. No freeze
triggered under the [error budget policy](../slos.md#what-happens-when-the-budget-is-exhausted).
