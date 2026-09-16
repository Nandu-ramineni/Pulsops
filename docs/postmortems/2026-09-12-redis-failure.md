# Postmortem: Redis Failure

## Incident Summary

Stopping Redis exposed a real bug in `order-service`'s cache-aside
fallback: instead of degrading gracefully as the architecture claimed, the
first injection hung an order-creation request for over three minutes with
no natural timeout. Fixed mid-incident and re-verified clean: with the fix
in place, Redis being down produced zero user-visible failure, exactly as
designed.

## Severity

**SEV-4** (final, post-fix) — no user-visible impact once the fix was in
place, matching the intended severity for a single dependency degrading
alone (per the [severity table](../incident-response.md#severity-levels)).
This number needs a caveat that would be dishonest to omit: **before the
fix, the actual user-visible severity was SEV-1** — order creation hung
indefinitely for affected requests, a full outage for anyone who hit it.
The same failure mode carried two completely different severities
depending on a code defect the architecture doc assumed didn't exist.

## Impact

**Post-fix (the design working as intended):** no availability impact.
Cache errors ran at 2.12/s (matching the miss rate) with every request
still completing successfully, just slower on a miss (807ms for the first
request after Redis went down, 7-13ms for subsequent ones). The
availability SLI dipped to **0.9813** during the window, but this was
leftover contamination from the *first* (buggy) attempt's 502s aging out
of the 5-minute window — confirmed by breaking 5xx down by route: 48
failures, all `gateway /api/orders 502`, all inside the ~3-minute pre-fix
window. Zero new failures occurred after the fix.

**Pre-fix (the bug):** a manual order-creation request hung with no
response for over three minutes and only returned because an unrelated
container rebuild forcibly reset the connection — for real traffic hitting
this path, that is a full, unbounded outage.

## Timeline

All times UTC. The first attempt's alert-firing time was not captured —
see the note in Detection below.

| Time (UTC) | Event |
|---|---|
| 15:50:47.000 | First failure injected (buggy code path) — `./scripts/break-redis.sh` |
| not captured | Manual order-creation request hangs; no response for 3+ minutes |
| not captured | Hang ends only because an unrelated container rebuild reset the connection — not a designed recovery |
| not captured | Root cause identified: GET-path cache-aside fallback rethrows instead of degrading; `reconnectStrategy` retries forever |
| not captured | Mitigation applied — fix deployed mid-incident (bounded reconnect, bounded per-operation timeout, corrected fallback) |
| 15:55:12.000 | Second failure injected, clean, with the fix in place |
| 16:01:42.154 | `RedisErrors` reached `firing` |
| 16:07:07.000 | Redis restarted (mitigation for the clean run) |
| 16:16:42.154 | `RedisErrors` reached `resolved` (exactly 15m after firing — see MTTR note) |
| 16:07:07.000 (approx.) | Incident closed — cache hit ratio returned to baseline within the next scrape interval |

## Detection

`RedisErrors` (ticket tier, per
[dependency-degraded.md](../runbooks/dependency-degraded.md)) fired for
the clean, post-fix run at 16:01:42.154Z. **No detection time is reported
for the first attempt** — the hang was found by a manual request, not by
an alert, and its firing timestamp was not recorded before the incident
moved on to fixing the underlying bug. That gap is itself worth noting:
the worst version of this incident (the hang) was caught by a human
noticing a stuck curl, not by monitoring.

## Root Cause

Two-part, and either one alone would have been a real defect:

1. `getUser()` in `userClient.js` caught a Redis `GET` failure and
   **rethrew it** instead of falling through to origin — the SET path
   already degraded gracefully, the GET path did not.
2. node-redis's default `reconnectStrategy` retries forever and never
   rejects, so `await connectRedis()` — called unconditionally before the
   try/catch — could hang with no upper bound at all.

Together, these turned "Redis is down" into "a fraction of requests hang
forever," rather than the documented "falls through to user-service,
slower but correct."

## Contributing Factors

The first hang's *end* was accidental, not designed: an unrelated
container rebuild reset the connection and let the hung request finally
return. Because of that, the true worst-case duration of the bug was never
directly observed — the incident stopped, but not because anything
recovered it. A real production instance of this bug, without a
coincidental restart nearby, would have hung for as long as the client
was willing to wait, which is a materially worse claim than "it took three
minutes."

## Resolution

**Mitigation** (deployed mid-incident, before the clean re-test):
`redisClient.js` — bounded `reconnectStrategy` (gives up after 5 attempts)
and `connectTimeout: 2000`. `userClient.js` — every Redis operation
wrapped in a 750ms `withTimeout()`; any failure now degrades to a cache
miss rather than rethrowing. This is what the architecture always claimed
happened; it wasn't implemented correctly on the read path.

**Separately**, the literal failure condition of the clean re-run (Redis
stopped) was resolved by restarting Redis at 16:07:07 UTC. Cache hit ratio
returned to its pre-incident baseline (99.4%) within the next scrape
interval.

## MTTD

```text
MTTD (clean, post-fix run) = 16:01:42.154 − 15:55:12.000
     = 6m30.2s
```

Consistent with the alert's `for: 5m` plus the ticket route's
`group_wait: 1m`.

## MTTR

```text
MTTR (RedisErrors resolved notification) = 16:16:42.154 − 16:01:42.154
     = 15m00.0s exactly — misleading, see note

MTTR (actual restoration, direct observation) = 16:07:07.000 − 15:55:12.000
     = 11m55s
```

The 15m00.0s "official" MTTR is an artifact, not a measurement: the
resolved notification for a ticket-tier alert only arrives at the next
`group_interval: 15m` flush, regardless of when the condition actually
cleared. The underlying condition cleared close to the true restoration
time (~16:07); the notification was simply batched. Ticket-tier alerts can
under-report recovery speed by up to their full `group_interval` — the
direct-observation figure is the honest number here.

## What Went Well

- Fault injection found a real, serious bug that manual curl-by-curl
  testing during earlier phases never caught — proving "the design
  tolerates this" required actually breaking it.
- Once the fix was deployed, the re-test was clean: zero new failures, and
  the 0.9813 SLI dip was fully explained by pre-fix 502s aging out of the
  window, not by anything still broken.
- Cache hit ratio recovered to its exact pre-incident baseline (99.4%)
  immediately once Redis returned.

## What Went Poorly

- Before the fix, order creation could hang **indefinitely** — worse than
  an error, because it never even surfaces as a fast failure a client or
  monitor can react to.
- The first hang only ended because of an unrelated operational action (a
  container rebuild for a different purpose), not because of any designed
  recovery path. Its true worst-case duration was never actually measured.
- A ticket-tier alert's resolved timestamp lagged real recovery by its
  full 15-minute `group_interval` — a naive MTTR pulled straight from
  Alertmanager here would have overstated recovery time by roughly 3
  minutes.

## Lessons Learned

1. "The design tolerates this" is a hypothesis, not a fact, until you
   break it for real. The documented cache-aside fallback had a real gap
   that only fault injection surfaced.
2. An unbounded retry strategy turns any dependency failure into a
   potential hang. Every external call needs an explicit upper bound,
   independent of the client library's own defaults — the same class of
   bug that Phase 15's load testing later found again in the
   `user-service` fetch call (see
   [docs/load-testing.md](../load-testing.md)), and partially again in a
   third place, `connectRedis()`'s own timeout wrapper not cancelling its
   underlying connection attempt (same document, Section 3).
3. A resolved notification's timestamp is not the recovery timestamp for
   any alert route with request-batching (`group_interval`). Use direct
   observation for a real MTTR, and treat the notification as directionally
   useful but bounded by its own batching window.

## Action Items

| Action | Owner | Priority |
|---|---|---|
| Audit every external dependency call in the codebase (Postgres, Redis, user-service) for a bounded timeout on *both* the connect and the operation — this incident and two later ones (Phase 15's load test, and its own re-verification run) each found a different call missing one | solo maintainer | P1 |
| Add an automated regression check (integration test that stops a dependency mid-request) so a rethrow-instead-of-degrade defect like this one can't silently return without a real fault-injection test catching it | solo maintainer | P2 |

This incident's contamination of the availability SLI (0.9813 for one
5-minute window, fully attributable to the pre-fix bug) recovered on its
own as the window rolled forward; it did not push the 30-day error budget
meaningfully negative on its own and triggered no error-budget-policy
freeze (see [docs/slos.md](../slos.md#what-happens-when-the-budget-is-exhausted)).
