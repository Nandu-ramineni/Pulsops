# Incident 003 — Bad Deployment

**Date:** 2026-09-12 · **Severity:** SEV-1 · **Status:** Resolved via rollback

## Scenario

A deploy introduces a real regression into `order-service`, and the
response is a rollback rather than a forward-fix — the standard first move
for a bad deploy, because reverting is faster and safer than debugging
under pressure.

## Hypothesis

A bug that makes `POST /orders` throw *after* the database write and the
queue publish succeed, but *before* the response is sent, will produce
100% error rate on order creation with **silent server-side success** — a
worse and more interesting failure than a clean crash, because a client
that retries a "failed" request risks creating a duplicate order.

## How to trigger

The bug and its fix are real git commits, not just a description:

```bash
git log --oneline  # 12f6777 (the bug), eabfd87 (the revert)
git show 12f6777    # res.status(202).json(ordr) - undefined variable
```

```bash
docker compose up -d --build --no-deps order-service   # deploy
# ... observe ...
git revert --no-edit <bad-commit>
docker compose up -d --build --no-deps order-service   # rollback
```

`--no-deps` matters: without it, `docker compose up` re-evaluates every
`depends_on` condition and can silently restart an *intentionally* stopped
dependency — exactly what happened by accident during Incident 002's first
attempt.

## Expected symptoms

100% failure rate on `POST /orders`, `AvailabilityErrorBudgetFastBurn`
firing, orders visibly created in Postgres despite the client seeing a 500.

## Actual symptoms

Deployed at **16:09:57Z**. Confirmed immediately:

```json
{"error":"internal error","message":"ordr is not defined"}
```
`HTTP 500`, on every order-creation request.

**Silent success, proven directly**, not inferred: a uniquely-tagged
request (`item="silent-success-proof-<timestamp>"`) that returned `500` to
the client was found, seconds later, sitting in Postgres:

```
 10988 | silent-success-proof-1789229450 | pending
```

The insert and the RabbitMQ publish both completed — the worker would go
on to process this order to `completed` normally. The client has no way to
know this happened; a naive retry-on-error client would create a second,
duplicate order for the same intent.

Error rate on the affected route: **100.0%**
(`sum(rate({status_code=~"5.."}[1m])) / sum(rate(...[1m]))` on
`POST /api/orders`). Overall availability SLI dropped from ~1.0 to
**0.8084** within the first evaluation window, and the 5-minute burn rate
hit **38.32x** — nearly three times the fast-burn page threshold.

## Metrics

```promql
sum(rate(http_requests_total{route="/api/orders",method="POST",status_code=~"5.."}[1m]))
  / sum(rate(http_requests_total{route="/api/orders",method="POST"}[1m]))   # 1.0
sli:availability:ratio_rate5m       # 0.8084
slo:availability:burn_rate5m        # 38.32
slo:availability:burn_rate1h        # 8.98 (diluted by the healthy hour before - see MTTD note)
```

## Logs

```logql
{job="pulseops", service="order-service", level="error"} | json | message="unhandled error in request pipeline"
```
Every line: `"ordr is not defined"` — the exact bug, in every log line,
which is what made root cause identification immediate rather than requiring
investigation.

## Traces

Any trace for a failed `POST /api/orders` in this window shows the full
span tree completing normally — `pg.query:INSERT`, `publish` — before the
error is thrown at the response-serialization point, visually confirming
the "silent success" shape directly in the waterfall.

## Alert

`AvailabilityErrorBudgetFastBurn`. Delivered **2026-09-12T16:14:27.803Z**.

## Detection time (MTTD)

```
MTTD = 16:14:27.803 − 16:09:57.000 = 4m30.8s
```

Slower than the raw error rate would suggest, because the alert's 1-hour
window was diluted by the healthy traffic before the bad deploy
(`burn_rate1h` only reached 8.98 at first check, below the 14.4 threshold,
even though the 5-minute window was already at 38.32). **Fast-burn
detection speed depends on how much healthy history sits in the longer
window — the same bug deployed onto an already-degraded hour would have
been caught faster.** This is an argument for keeping deploy-time error
budgets and windows in mind, not just the instantaneous error rate.

## Investigation

The bug was known in advance (it was deliberately introduced), so
"investigation" here is really a demonstration of how fast a real
investigation would have gone: the very first error-level log line names
the exact undefined variable, and a trace shows precisely where in the
request lifecycle it happens. In a real incident this would take under a
minute from "logs open" to "root cause identified" — the harder part is
almost always detection and the decision to look, not the lookup itself
once you're looking in the right place.

## Root cause

`services/order-service/src/routes/orders.js`, commit `12f6777`: the
success response referenced `ordr` instead of `order` — a one-character
typo that survived because nothing type-checks this codebase and the
happy-path response is the last line executed, so no test exercising only
the "does the order get created" question would have caught it without
also asserting on the *response*.

## Mitigation

`git revert --no-edit 12f6777`, rebuild, redeploy with `--no-edit --no-deps`.

## Recovery

Rollback started **16:14:51Z** (a `git revert` command; started only after
the alert fired, as a real on-call response would, not before). Deployed
and healthy at **16:15:07Z**. Verified immediately with a real order
creation returning `202`.

## MTTD / MTTR

```
MTTD = 16:14:27.803 − 16:09:57.000 = 4m30.8s
MTTR = 16:15:07.000 − 16:14:27.803 = 39.2s     (alert fired -> rollback deployed and healthy)
```

The rollback itself — revert, rebuild, redeploy, health-check pass — took
**16 seconds** of that 39.2s (16:14:51 to 16:15:07); the rest is the time
between the page and starting the rollback command.

## Classification

**SEV-1.** 100% of order-creation requests failed, for all users, with a
data-integrity risk (duplicate orders on client retry) layered on top of
the outage itself.

## Lessons learned

1. **A crash-free bug is more dangerous than a crash.** A hard crash gets
   caught by `ServiceDown`; this bug looked identical to a normal healthy
   process from the outside (successful DB writes, successful publishes)
   while returning 500 to every caller — the only signal was the
   application-level error rate.
2. **Silent server-side success behind a client-visible failure is a
   correctness bug, not just an availability one.** The postmortem action
   item this generates is not "fix the typo" (already done) but
   "order creation should be idempotent" (a request ID / idempotency key on
   `POST /orders`), so a client retry after a real or apparent failure
   can't create a duplicate. This is exactly the kind of finding an error
   budget policy should prioritize.
3. **`docker compose up` without `--no-deps` can silently undo a deliberate
   fault injection** by resurrecting a dependency your `depends_on` graph
   says should be healthy — a real operational trap, found the hard way
   during Incident 002's first attempt, and avoided here deliberately.
4. **Fast-burn detection speed is not a fixed number** — it depends on how
   much healthy traffic already sits inside the 1-hour window at the moment
   the incident starts.
