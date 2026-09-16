# Postmortem: Database Slowdown

## Incident Summary

A CPU throttle on the Postgres container (simulating resource contention —
a noisy neighbor or an undersized instance) raised gateway p95 latency
~45x for roughly 10m40s. No requests failed; every request just got much
slower.

## Severity

**SEV-2** — every request against a Postgres-backed route got dramatically
slower (gateway p95 ~45x baseline), but nothing failed outright. Per the
severity table in [incident-response.md](../incident-response.md#severity-levels):
"major user impact... but the system is not entirely down."

## Impact

No availability impact — this incident produced pure latency degradation,
not errors. `db_query_duration_seconds` p95 rose from ~5ms to 84.7ms in
order-service (17x) and to 39.3ms in user-service; gateway p95 across all
routes rose from an established ~20ms baseline (Phase 9) to **910.2ms**
(~45x), measured ~45s after injection under continuous mixed load. The
latency SLO's 5-minute burn rate reached **16.95x** during the window —
well past the fast-burn page threshold of 14.4x.

## Timeline

All times UTC, from Prometheus/Alertmanager.

| Time (UTC) | Event |
|---|---|
| 15:56:26.000 | Failure injected — `docker update --cpus=0.05` on the Postgres container |
| 16:00:57.939 | `LatencyErrorBudgetFastBurn` reached `firing` |
| 16:00:57.939 | Investigation started (paged by the fast-burn alert) |
| 16:00:57.939 | Root cause identified — a controlled injection, so the cause was known in advance; the investigation demonstrated the dashboard would have isolated it independently (see Detection) |
| 16:07:06.000 | Mitigation applied — `docker update --cpus=0` (throttle removed) |
| 16:12:57.808 | `LatencyErrorBudgetFastBurn` reached `resolved` |
| 16:12:57.802 | `LatencyErrorBudgetSlowBurn` reached `firing` — see Detection note below; this is **not** a second incident |
| 16:12:57.808 | Incident closed |

## Detection

`LatencyErrorBudgetFastBurn` (page tier) fired and is the number that
matters — it's what actually paged. The Incident Investigation dashboard's
Dependency Latency panel then isolated the spike to Postgres specifically:
Redis and the downstream user-service call were both unaffected during the
window, confirming the throttle's blast radius was exactly what was
targeted. Runbook used: [slo-burn-rate.md](../runbooks/slo-burn-rate.md).

`LatencyErrorBudgetSlowBurn` also fired, at 16:12:57.802 — five minutes
*after* the throttle was already removed. This looks like a second,
independent detection but isn't one: slow-burn uses 6h/30m windows, and the
10m40s incident was still inside both windows when the burn crossed the 6x
threshold. The alert that looks like a second detection actually fired
after the incident was already resolved.

## Root Cause

Deliberately injected: `docker update --cpus=0.05` on the Postgres
container. CPU-throttling (rather than stopping) the database made every
query individually slower without exhausting the connection pool —
`db_pool_connections{state="waiting"}` stayed at **0** throughout, ruling
out queueing as a factor. This is a genuinely different failure shape from
a stopped or crashed dependency: no errors, no pool saturation, just
uniformly worse latency on every query.

## Contributing Factors

None beyond the injected fault itself — this was a single, direct cause
with no secondary factor that worsened or prolonged it. Worth noting as a
detection gap rather than a contributing cause: this incident produced
**no error-level log lines at all** (see `docs/load-testing.md`'s and this
project's other incidents' logs sections for contrast) — `db_query_duration_seconds`
moving was the *only* signal. A response strategy that relies on log
scanning alone would have found nothing here.

## Resolution

Mitigation and fix were the same action: removing the throttle
(`docker update --cpus=0`) at 16:07:06Z. Gateway p95 returned toward
baseline within the next scrape interval; a direct request roundtrip
immediately after restoration completed in single-digit milliseconds,
confirming full recovery independent of the rolling-window metrics (which
briefly still showed elevated values purely as a windowing artifact, not
ongoing impact).

## MTTD

```text
MTTD = 16:00:57.939 − 15:56:26.000
     = 4m31.9s
```

## MTTR

```text
MTTR (direct observation: injection → restoration) = 16:07:06.000 − 15:56:26.000
     = 10m40s

MTTR (strict definition: alert firing → alert resolved) = 16:12:57.808 − 16:00:57.939
     = 11m59.9s  — misleading, see note
```

The strict-definition MTTR overstates recovery time. The fast-burn alert
did not resolve at 16:12:57.808 because recovery took that long — it
resolved at that moment because its own 5m/1h windows needed to clear of
the incident's elevated samples, which happened to land close to when
slow-burn separately crossed its threshold (see Detection). The direct-
observation figure (10m40s, injection to the mitigation command
completing, cross-checked against the immediate post-restoration single-
digit-ms roundtrip) is the honest recovery time for this incident.

## What Went Well

- The Incident Investigation dashboard's Dependency Latency panel isolated
  the problem to Postgres specifically, immediately and correctly — Redis
  and the user-service call both showed no corresponding change.
- `PostgresConnectionPoolSaturated` correctly did **not** fire: pool
  saturation was never the actual mechanism here, and the alert didn't
  produce a false positive by firing anyway.
- The fast-burn page arrived in 4m31.9s, comfortably fast enough to act on.

## What Went Poorly

- The original hypothesis (that queries would queue and exhaust the pool)
  was wrong. Had this been a real incident, an on-call response guided by
  that assumption first would have looked at the wrong panel before the
  data corrected it.
- Zero log-based signal. Anyone paged by this alert and reflexively
  checking logs first (rather than the latency dashboard) would see
  nothing useful.
- The slow-burn alert firing five minutes after the actual fix, timestamped
  in a way that reads like a fresh detection, is a real source of confusion
  for whoever is on call if they don't already know to check the alert's
  own window annotation.

## Lessons Learned

1. A CPU throttle produces a genuinely different failure shape than a
   stopped or crashed dependency — no errors, no pool saturation, just
   uniformly worse latency. An incident library (and an on-call response)
   needs more than one mental model for "a dependency is unhealthy."
2. Multi-window burn-rate alerts can report events out of chronological
   order relative to the underlying incident. A slow-tier alert firing
   after a fast-tier alert has already resolved is not a bug and not a new
   incident — it's two different windows looking at overlapping but
   distinct slices of history. Read the alert's own annotation for what it
   measures before reacting to firing order alone.

## Action Items

| Action | Owner | Priority |
|---|---|---|
| Add a Postgres resource-contention (CPU) panel to the observability dashboards, distinct from the existing pool-saturation panel — this incident showed pool metrics stay completely flat while CPU throttling is the actual, real cause | solo maintainer | P2 |
| Document the slow-burn-after-fast-burn-resolves pattern directly in the `LatencyErrorBudgetSlowBurn` alert annotation, not just in this postmortem, so it's visible at the moment it could be misread | solo maintainer | P3 |

This incident's 5-minute burn rate (16.95x) sustained for roughly 10m40s
(~0.178h) out of the 30-day SLO window works out to
`16.95 × (0.178 / 720) ≈ 0.42%` of the monthly latency error budget spent
in this single event — small on its own, but a derived approximation from
one measured burn-rate sample rather than an integral over the whole
window, so it's reported as a rough order of magnitude, not a precise
figure. Did not push the budget negative; no error-budget-policy freeze
triggered by this incident alone.
