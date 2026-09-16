# Postmortem: Message Queue Backlog

## Incident Summary

The worker stopped consuming from `order.created` while order-service kept
publishing, growing an unbounded backlog with no user-visible failure.
`ServiceDown{job="worker"}` caught the stopped process correctly and fast;
the alert specifically meant to catch the *consequence* —
`QueueBacklogGrowing` — did not fire at all for the first 48 minutes of a
real, severe, continuously growing backlog, because its expression could
not tolerate its own consumed-side metric going absent.

## Severity

**SEV-3** — no user-facing failure at any point; orders were accepted
successfully throughout. The impact is a correctness/freshness problem
(orders stuck at `pending` far longer than intended), matching the
severity this project's own runbook had already called out in advance for
a worker outage (per the [severity table](../incident-response.md#severity-levels)
and [service-down.md](../runbooks/service-down.md)).

## Impact

No availability impact — `order-service` accepted every request normally
throughout. The impact is entirely a correctness/freshness one: **~34,591
messages** were outstanding in the backlog at the point the worker was
restored. `queue_messages_published_total` never slowed (17,000+ matching
"published order.created" log lines during the window); only consumption
stopped. At the measured steady-state drain rate of 4.17 messages/sec once
the worker resumed, draining the backlog fully would take
`34,591 / 4.17 ≈ 8,295s ≈ 2h18m` — a calculated projection from a real,
measured rate, not observed to completion in this report.

## Timeline

All times UTC.

| Time (UTC) | Event |
|---|---|
| 15:50:01.000 | Failure injected — worker stopped, order-creation traffic kept flowing |
| 15:52:32.194 | `ServiceDown{job="worker"}` reached `firing` |
| 15:52:32.194 | Investigation started (paged by `ServiceDown`) |
| ~16:22:25.796 | Root cause of the *second*, more important problem identified: `QueueBacklogGrowing`'s expression evaluates to no data (not zero) once the consumed-side series goes absent |
| 16:22:25.796 | Mitigation applied — fixed alert expression (`or vector(0)`) reloaded via `docker compose restart prometheus` |
| 16:38:35.752 | `QueueBacklogGrowing` (fixed version) reached `firing`, confirming the fix actually works |
| 16:40:26.000 | Worker restarted |
| 16:40:34.000 | Worker confirmed healthy and consuming again (worker logs show `order processed`) |
| 16:40:26.000 (approx.) | Incident closed — publish-side backlog growth stopped; full drain still in progress at time of writing (see Impact) |

## Detection

Two separate alerts, two separate outcomes:

- **`ServiceDown{job="worker"}` worked exactly as designed** — fired in
  2m31.2s, telling an on-call engineer "the worker is down." Runbook:
  [service-down.md](../runbooks/service-down.md).
- **`QueueBacklogGrowing` did not fire at all** for 48 minutes of a real,
  severe backlog — see Root Cause. `ServiceDown` did not, and structurally
  could not, tell anyone "and a backlog of tens of thousands of messages
  is building because of it." Before the fix, only the runbook's own prose
  carried that warning; no metric did.

## Root Cause

Primary (the injected fault, as designed): the worker was stopped.

Secondary, and the more important finding: `QueueBacklogGrowing`'s
expression was

```promql
sum(rate(queue_messages_published_total{status="success"}[10m]))
-
sum(rate(queue_messages_consumed_total[10m]))
> 0.1
```

`queue_messages_consumed_total` exists only on the worker's own
`/metrics`. Once the worker had been down long enough for Prometheus to
exceed its default 5-minute scrape staleness window, that series went
**absent**, not zero. In PromQL, `present_vector - absent_vector`
evaluates to **no result at all**, not `present_vector - 0`. The alert's
entire expression silently stopped evaluating to anything — structurally
incapable of firing — for exactly the scenario (a fully dead consumer)
that this alert most needs to catch.

## Contributing Factors

`queue_messages_published_total`'s raw instant value after the incident's
multiple order-service restarts (17,418) looked like a plausible total and
was wrong — the correct cumulative figure, computed via `increase()` over
a window wide enough to span every counter reset, was 37,284. Prometheus
counters reset to zero on process restart, and this incident's own
order-service restarted four times (Incidents 003 and 005 both redeployed
it during the same broader test run). Reading the raw value instead of
`increase()`/`rate()` across a known restart would have understated the
true backlog size significantly, independent of the absent-vector bug.

## Resolution

Fixed the alert expression to treat absence as zero, which is the
semantically correct interpretation here (no recent consumption *is* zero
consumption):

```promql
sum(rate(queue_messages_published_total{status="success"}[10m]))
-
(sum(rate(queue_messages_consumed_total[10m])) or vector(0))
> 0.1
```

Applied to both the alert rule and the matching Grafana panel, reloaded
via `docker compose restart prometheus`. That reload itself reset every
alert's pending/firing timer, including `ServiceDown{worker}`'s, which had
already been firing continuously for 32 minutes and had to re-accumulate
its `for: 2m` from scratch — restarting Prometheus to ship a rule fix is
itself a small, real detection outage for whatever else is in flight at
that moment.

Separately, the underlying fault (worker stopped) was mitigated by
restarting the worker at 16:40:26 UTC, confirmed processing again by
16:40:34 UTC.

## MTTD

```text
MTTD (ServiceDown, the alert that actually worked) = 15:52:32.194 − 15:50:01.000
     = 2m31.2s

MTTD (QueueBacklogGrowing, as originally shipped) = undefined — it never fired

MTTD (QueueBacklogGrowing, post-fix, from the fix's own reload) =
     16:38:35.752 − 16:22:25.796 = 16m9.96s
```

## MTTR

```text
MTTR (worker itself, direct observation) = 16:40:26.000 − 15:50:01.000
     = 50m25s

MTTR (queue stopped growing) = near-immediate once the worker resumed
     (drain rate 4.17/s > 0/s)

MTTR (queue fully drained) = ~2h18m, calculated from the measured 4.17/s
     drain rate against the 34,591-message backlog — not observed to
     completion in this report
```

The 50m25s worker-down duration was deliberate, not an artifact of slow
response — the incident was left running to accumulate a large enough
backlog to be measurably interesting, not because detection or mitigation
were actually slow.

## What Went Well

- `ServiceDown` did exactly what it was built for: fast, correct detection
  of the stopped process, in 2m31.2s.
- The runbook had already, in advance, correctly called out that a worker
  outage produces no user-visible failure and orders silently stay
  `pending` — this incident confirmed that prose warning was accurate.
- Once the bug was found, the fix (`or vector(0)`) was verified to
  actually work by reloading it and confirming `QueueBacklogGrowing` fired
  correctly against the still-live backlog, rather than just asserting the
  PromQL was correct on paper.

## What Went Poorly

- The alert specifically designed to catch this exact scenario —
  consumption fully stopped — was structurally incapable of firing for it,
  for 48 minutes, because of an absent-vector subtraction bug.
- Confirming the backlog's existence and size, before the fix, required
  manually querying both counters and reasoning about the subtraction by
  hand — exactly the gap the fixed alert (and the dashboard panel using
  the same expression) closes.
- Restarting Prometheus to deploy the rule fix reset every other alert's
  in-flight timer, including an already-32-minutes-firing `ServiceDown`.
  Had that been a live page mid-incident rather than a lower-urgency
  backlog alert, the reset could have delayed real-time visibility.

## Lessons Learned

1. A metric that only exists on the failing component can vanish exactly
   when it's needed most. Any alert comparing two sides of a
   producer/consumer relationship needs to consider what its own
   expression evaluates to if one side's series goes entirely absent, not
   just degraded — `or vector(0)` is the specific fix here, but "what does
   this evaluate to on total absence?" is the general question every
   multi-series alert expression should be checked against.
2. Restarting Prometheus to ship a rule fix resets in-flight alert state
   for everything, not just the rule being fixed. A live page's `for:`
   timer restarting from zero mid-incident is a real cost of shipping an
   alerting fix reactively.
3. Never trust an instant counter value across a known process restart;
   always use `increase()`/`rate()` over a window wide enough to span every
   reset.
4. An alert resolving only confirms what it measures. This alert is
   specifically a *growth* detector — confirming it clears only confirms
   the backlog stopped getting worse, not that it's gone. Reporting a
   calculated ETA from a measured steady rate, rather than inventing a
   number or waiting out a multi-hour drain, is the honest middle ground.

## Action Items

| Action | Owner | Priority |
|---|---|---|
| Audit every existing multi-series alert expression (not just `QueueBacklogGrowing`) for the same absent-vs-zero failure mode — any comparison across two independently-scraped targets has the same structural risk | solo maintainer | P1 |
| Add a synthetic/regression test that stops the worker and asserts `QueueBacklogGrowing` actually fires within its expected window, so this specific class of regression can't silently return | solo maintainer | P2 |
| Investigate a Prometheus rule-reload mechanism that doesn't reset unrelated alerts' in-flight `for:` timers (e.g. `promtool` hot-reload via `SIGHUP`/the reload HTTP endpoint instead of a full container restart) | solo maintainer | P3 |

No availability SLI impact occurred in this incident, so no error-budget
calculation applies — the impact here is entirely the calculated 2h18m
drain-time projection above, tracked as an operational cost, not a budget
spend.
