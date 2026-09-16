# Postmortem: Bad Deployment

## Incident Summary

A one-character typo (`ordr` instead of `order`) deployed to
`order-service` threw *after* the database write and queue publish already
succeeded, returning `500` to 100% of order-creation requests while
silently completing every one of them server-side — a data-integrity risk
layered on top of a full outage. Resolved via `git revert` and redeploy in
16 seconds once the rollback command started.

## Severity

**SEV-1** — 100% of order-creation requests failed, for all users, per the
[severity table](../incident-response.md#severity-levels)'s definition of
a broken primary user journey. A data-integrity risk (duplicate orders on
client retry) sits on top of the outage itself.

## Impact

Error rate on `POST /api/orders`: **100.0%**
(`sum(rate({status_code=~"5.."}[1m])) / sum(rate(...[1m]))`). Overall
availability SLI dropped from ~1.0 to **0.8084** within the first
evaluation window; the 5-minute burn rate hit **38.32x** — nearly three
times the fast-burn page threshold (14.4x). Every failed request also
completed successfully server-side: the insert and the RabbitMQ publish
both succeeded, meaning the worker would go on to process each of these
orders to `completed` normally, invisibly to the client that saw a 500.

## Timeline

All times UTC, from Prometheus/Alertmanager and the deploy/rollback
commands' own timestamps.

| Time (UTC) | Event |
|---|---|
| 16:09:57.000 | Bad deploy went live (`docker compose up -d --build --no-deps order-service`, commit `12f6777`) |
| 16:09:57.000 (approx.) | Every `POST /orders` begins returning `500` while still writing to Postgres and publishing to RabbitMQ |
| 16:14:27.803 | `AvailabilityErrorBudgetFastBurn` reached `firing` |
| 16:14:27.803 | Investigation started (paged by the alert) |
| 16:14:27.803 (near-immediate) | Root cause identified — the first error-level log line names the exact undefined variable |
| 16:14:51.000 | Mitigation applied — `git revert --no-edit 12f6777` started |
| 16:15:07.000 | Rollback deployed and healthy; verified with a real order creation returning `202` |
| 16:15:07.000 | Incident closed |

## Detection

`AvailabilityErrorBudgetFastBurn` (page tier). Delivered 16:14:27.803Z —
slower than the raw 100% error rate alone would suggest, because the
alert's 1-hour window was diluted by healthy traffic from before the bad
deploy: `burn_rate1h` only reached 8.98 at first check (below the 14.4
threshold) even though the 5-minute window was already at 38.32.
Fast-burn detection speed depends on how much healthy history sits in the
longer window at the moment an incident starts — the same bug deployed
onto an already-degraded hour would have paged faster.

## Root Cause

`services/order-service/src/routes/orders.js`, commit `12f6777`: the
success response referenced `ordr` instead of `order` — a one-character
typo. It survived because nothing type-checks this codebase and the
happy-path response is the last line executed in the handler, so any test
that only asserts "does the order get created" (without also asserting on
the *response*) would not have caught it.

## Contributing Factors

Nothing type-checks this codebase, and no test in the existing suite
asserts on the shape of a successful response body, only on the resulting
side effects — this specific gap in test coverage is what let a
one-character typo reach a real deploy. The failure also happened to occur
*after* both side effects (DB write, queue publish) completed, which is
what turned an otherwise-ordinary crash-on-deploy into the harder,
silent-success variant.

## Resolution

Mitigation and fix were the same action: `git revert --no-edit 12f6777`,
rebuild, redeploy with `--no-deps` (deliberately, to avoid resurrecting
any other intentionally-stopped dependency — see Incident 002's first
attempt for why that matters). The rollback itself — revert, rebuild,
redeploy, health-check pass — took 16 seconds once started (16:14:51 to
16:15:07); the remaining ~24 seconds of the total 39.2s window is the time
between the page landing and the rollback command starting.

## MTTD

```text
MTTD = 16:14:27.803 − 16:09:57.000
     = 4m30.8s
```

## MTTR

```text
MTTR = 16:15:07.000 − 16:14:27.803
     = 39.2s   (alert fired → rollback deployed and healthy)
```

## What Went Well

- The very first error-level log line named the exact undefined variable
  (`"ordr is not defined"`) — root cause identification took seconds once
  the logs were open, not minutes.
- A trace for a failed request showed the full span tree (Postgres insert,
  queue publish) completing normally before the error was thrown at the
  response-serialization point, visually confirming the silent-success
  shape directly in the waterfall rather than requiring inference.
- The rollback itself, once started, took only 16 seconds end to end
  (revert → rebuild → redeploy → health-check pass).
- Silent success was proven directly, not inferred: a uniquely-tagged test
  request that returned `500` to the client was found seconds later
  sitting in Postgres as a normal `pending` row.

## What Went Poorly

- A crash-free bug is more dangerous than a crash: this looked identical
  to a healthy process from the outside (successful DB writes, successful
  publishes) while returning 500 to every caller. The only signal was the
  application-level error rate — a hard crash would have been caught by
  `ServiceDown` and would have been unambiguous.
- Detection speed was not purely a function of the bug's severity: the
  1-hour window's healthy history diluted the burn rate enough that the
  slower of the two windows almost didn't cross its threshold on the first
  evaluation, despite the 5-minute window already reading nearly 3x the
  page threshold.
- Order creation is not currently idempotent. A client that retries a
  "failed" request during this exact failure mode risks creating a
  duplicate order — the incident didn't demonstrate a duplicate directly,
  but the code path makes one possible on any retry.

## Lessons Learned

1. A crash-free bug is more dangerous than a crash. It bypasses process-
   health alerting entirely and is only visible in application-level error
   rate — a system needs both.
2. Silent server-side success behind a client-visible failure is a
   correctness bug, not just an availability one. The fix for the typo
   doesn't fix the underlying exposure: a client can't safely retry a
   "failed" `POST /orders` without risking a duplicate.
3. `docker compose up` without `--no-deps` can silently undo a deliberate
   fault injection (or, in a real deploy, resurrect a dependency your
   `depends_on` graph says should already be healthy) — a real operational
   trap, discovered the hard way during Incident 002's first attempt and
   deliberately avoided here.
4. Fast-burn detection speed is not a fixed number for a fixed error
   rate — it depends on how much healthy traffic already sits inside the
   longer window at the moment the incident starts.

## Action Items

| Action | Owner | Priority |
|---|---|---|
| Add an idempotency key to `POST /orders` (client-supplied request ID, deduplicated server-side) so a retry after a real or apparent failure can't create a duplicate order | solo maintainer | P1 |
| Add a test that asserts on the actual response body shape of a successful order creation, not just on the resulting database row — this specific typo would have been caught by that alone | solo maintainer | P1 |
| Consider a minimal type-check or lint rule that would catch a reference to an undefined variable at build time rather than first-request time | solo maintainer | P2 |

This incident's 5-minute burn rate (38.32x) sustained for the ~5m10s
between deploy and rollback (16:09:57 to 16:15:07, 0.0862h) against the
30-day SLO window works out to `38.32 × (0.0862 / 720) ≈ 0.46%` of the
monthly availability error budget in this single event — a derived
approximation from the one measured 5-minute-window burn-rate sample, not
an integral over the actual varying rate, reported as an order of
magnitude. Combined with the SLI dropping to 0.8084 in the first
evaluation window, this incident is a real, measurable error-budget spend
and the action items above should be treated as prioritized per the
[error budget policy](../slos.md#what-happens-when-the-budget-is-exhausted)
until the budget recovers.
