# Incident 002 — Redis Failure

**Date:** 2026-09-12 · **Severity:** SEV-4 (see [Classification](#classification)) · **Status:** Resolved, with a real bug found and fixed mid-incident

## Scenario

Redis backs order-service's cache-aside lookup of user profiles. The
architecture's stated design is that Redis can fail completely and order
creation should keep working — just slower, falling through to
user-service on every request instead of most.

## Hypothesis

Stopping Redis outright will spike `cache_errors_total`, drop the cache hit
ratio to 0%, and raise `dependency_requests_total{dependency="user-service"}`
proportionally — while `sli:availability:ratio` stays at 1.0, because the
architecture is supposed to tolerate this.

## How to trigger

```bash
./scripts/break-redis.sh
# ... observe ...
docker exec pulseops-redis-1 redis-cli ping   # to confirm restored
./scripts/restore-service.sh redis "docker exec pulseops-redis-1 redis-cli ping"
```

## Expected symptoms

`RedisErrors` fires (ticket, not a page — see
[dependency-degraded.md](../../docs/runbooks/dependency-degraded.md)).
Availability SLI unaffected. Cache hit ratio drops to 0%. No user-visible
failure.

## Actual symptoms — first attempt: the hypothesis was wrong

The first injection (15:50:47 UTC) did **not** match the hypothesis. A
manual order-creation request hung with **no response for over three
minutes**, and only returned at all because rebuilding the order-service
container for an unrelated reason forcibly reset the connection —
Alertmanager's own log shows the client giving up with `502 upstream
unavailable`, not a graceful degradation.

Root cause: `getUser()` in `userClient.js` caught a Redis `GET` failure and
**rethrew it** instead of falling through to origin — the SET path already
degraded gracefully, the GET path did not. Worse, node-redis's default
`reconnectStrategy` retries forever and never rejects, so
`await connectRedis()` — called unconditionally before the try/catch — could
hang with no upper bound at all. This is a real bug in the code, not a
property of Redis, discovered only by actually breaking Redis rather than
trusting the documented design.

### Fix, deployed mid-incident

- `redisClient.js`: bounded `reconnectStrategy` (gives up after 5 attempts)
  and `connectTimeout: 2000` so `client.connect()` can actually reject
  instead of retrying forever.
- `userClient.js`: every Redis operation wrapped in a 750ms
  `withTimeout()`; any failure — connect, get, or set — now degrades to a
  cache miss rather than rethrowing. This is what the architecture always
  claimed happened; it just wasn't implemented correctly on the read path.

## Actual symptoms — second attempt, with the fix in place

Redis was stopped again cleanly at **15:55:12 UTC**. Order creation:

| | Before fix | After fix |
|---|---|---|
| First request after Redis down | **hung, no natural timeout, resolved only when the container was replaced** | 807ms, `202` |
| Subsequent requests | not tested (still hung) | 7-13ms, `202` |
| Cache errors | 1/s | 2.12/s (same failure rate, now handled) |
| Availability SLI (5m) | contaminated by the hang's 502s | **0.9813 → recovered to ~1.0 once the pre-fix 502s aged out of the window** |

The dip to 0.9813 in the SLI was leftover 502s from the *original bug*, not
from Redis being down per se — confirmed by breaking down 5xx by route:
48 failures, all `gateway /api/orders 502`, all inside the ~3-minute
pre-fix window. Zero new failures occurred after the fix.

## Metrics

```promql
sum(rate(cache_errors_total{operation="get"}[2m]))          # 2.121/s during outage
sum(rate(dependency_requests_total{dependency="user-service",status="success"}[2m]))  # 2.299/s - matches the miss rate
sli:availability:ratio_rate5m                                # stayed ~1.0 post-fix
```

## Logs

```logql
{job="pulseops", service="order-service", level="warn"} | json | message="cache read failed, degrading to origin"
```

## Traces

Any trace for a `POST /api/orders` during the outage shows a `redis.get`
span erroring quickly (post-fix) rather than a multi-minute gap — the
before/after is visible directly in span duration.

## Alert

`RedisErrors` (ticket tier). Delivered **2026-09-12T16:01:42.154Z**.

## Detection time (MTTD)

```
MTTD = 16:01:42.154 − 15:55:12.000  (clean, post-fix injection)
     = 6m30.2s
```

Consistent with the alert's `for: 5m` plus the ticket route's `group_wait: 1m`.

## Investigation

Dashboard → Incident Investigation → Dependency Health confirmed
`cache_errors_total{operation="get"}` climbing with zero corresponding rise
in `http_requests_total{status_code=~"5.."}` — exactly the signature of a
dependency degrading without user impact, *after* the fix. Before the fix,
the signature was a request that simply never completed, which is worse
than an error: it doesn't even show up as a fast 5xx, it shows up as
nothing until something else times out.

## Root cause

Two-part: (1) the GET-path cache-aside fallback rethrew instead of
degrading, and (2) node-redis's default reconnect strategy never gives up,
so there was no bound on how long a hung request could wait. Either one
alone would have been a real defect; together they turned "Redis is down"
into "a fraction of requests hang forever."

## Mitigation

Deployed the fix (bounded reconnect + bounded per-operation timeout +
correct fallback-on-error) mid-incident, then re-ran the scenario clean to
verify.

## Recovery

Redis restarted at **16:07:07 UTC**. Cache hit ratio returned to baseline
(measured before injection at 99.4%) within the next scrape interval.

## MTTD / MTTR summary

| | Value |
|---|---|
| MTTD (post-fix, clean run) | 6m30.2s |
| MTTR (RedisErrors resolved notification) | 15m00.0s exactly (see note) |
| MTTR (actual restoration, from direct observation) | 11m55s (16:07:07 − 15:55:12) |

**The 15m00.0s "official" MTTR is misleading, and that's itself a finding.**
The resolved notification for a *ticket*-tier alert only arrived exactly 15
minutes after the firing notification — precisely Alertmanager's
`group_interval: 15m` for the ticket route. The underlying condition
almost certainly cleared close to the true restoration time (~16:07); the
notification was simply batched to the next group-flush cycle. **Ticket-tier
alerts can under-report recovery speed by up to their `group_interval`** —
worth knowing before using a ticket alert's resolved timestamp as a
reliability metric.

## Classification

**SEV-4.** No user-visible impact once the fix was in place — which is
exactly the point of a cache-aside pattern. Before the fix, the *actual*
user-visible severity was SEV-1 (order creation hung indefinitely for
affected requests) — an important distinction: the same failure mode had
two completely different severities depending on a code defect the
architecture doc assumed didn't exist.

## Lessons learned

1. **"The design tolerates this" is a hypothesis, not a fact, until you
   break it for real.** The documented cache-aside fallback had a real gap
   that only fault injection surfaced.
2. **An unbounded retry strategy turns any dependency failure into a
   potential hang.** Every external call needs an explicit upper bound,
   independent of the client library's own defaults.
3. **A resolved notification's timestamp is not the recovery timestamp** for
   any alert route with request-batching (`group_interval`). Use direct
   observation (the restore script's own timestamp) for a real MTTR, and
   treat the notification as directionally useful but bounded by its own
   batching window.
