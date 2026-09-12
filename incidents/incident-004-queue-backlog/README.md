# Incident 004 — Message Queue Backlog

**Date:** 2026-09-12 · **Severity:** SEV-3 (see [Classification](#classification)) · **Status:** Mitigated (worker resumed processing); full drain in progress, not yet complete at time of writing

## Scenario

The worker stops consuming from `order.created` while `order-service` keeps
publishing — orders keep being accepted, but nothing marks them
`completed`. This is the incident this project has most explicitly warned
about in its own docs (`docs/runbooks/service-down.md`: *"No user-visible
failure. Orders are accepted and stay pending forever — a silent
correctness problem, not an outage."*) — this run is where that warning
gets tested for real.

## Hypothesis

Stopping the worker while order-creation traffic continues will grow the
gap between `queue_messages_published_total` and
`queue_messages_consumed_total` without bound, and `QueueBacklogGrowing`
will fire once that gap has exceeded 0.1/s for 15 continuous minutes.

## How to trigger

```bash
./scripts/create-queue-backlog.sh
# ... keep order-creation traffic flowing ...
./scripts/restore-service.sh worker "curl -sf http://localhost:4003/health"
```

## Expected symptoms

`ServiceDown{job="worker"}` fires quickly (no user impact, per its own
severity in the runbook). `QueueBacklogGrowing` fires within roughly 16
minutes of sustained publish traffic (15m `for:` + up to ~1m ticket
`group_wait`). Orders stay `pending`.

## Actual symptoms

`ServiceDown{job="worker"}` fired exactly as expected — see
[Detection](#detection-time-mttd) below. **`QueueBacklogGrowing` did not
fire at all for the first 48 minutes of a real, severe, continuously
growing backlog.** That is not a measurement gap in this report; it is the
actual, verified behavior of the alert as originally written, and it is
the central finding of this incident.

### The bug

`QueueBacklogGrowing`'s expression was:

```promql
sum(rate(queue_messages_published_total{status="success"}[10m]))
-
sum(rate(queue_messages_consumed_total[10m]))
> 0.1
```

`queue_messages_consumed_total` exists only on the worker's own `/metrics`.
Once the worker had been down long enough for Prometheus to exceed its
scrape staleness window (5 minutes by default) without a fresh sample,
that time series went **absent** — not zero. In PromQL, `present_vector -
absent_vector` produces **no result at all**, not `present_vector - 0`.
The alert's entire expression silently stopped evaluating to anything,
which means it stopped being "not triggered" and became **structurally
incapable of firing**, for exactly the scenario — a fully dead consumer —
that this alert most needs to catch.

Confirmed directly: at the moment of diagnosis, `queue_messages_published_total`
had a real rate; `queue_messages_consumed_total` returned `NO DATA`; the
subtraction returned `NO DATA`; the dashboard's "Queue Backlog Trend" panel
(same expression) would have shown nothing on the exact line meant to show
this exact failure.

### The fix

```promql
sum(rate(queue_messages_published_total{status="success"}[10m]))
-
(sum(rate(queue_messages_consumed_total[10m])) or vector(0))
> 0.1
```

`or vector(0)` treats "no data" on the consumed side as zero, which is the
semantically correct interpretation here: no recent consumption *is* zero
consumption. Applied to both the alert rule and the matching Grafana panel.
Reloaded via `docker compose restart prometheus` — which itself reset
**every** alert's pending/firing timer, including `ServiceDown{worker}`,
which had already been firing continuously for 32 minutes and had to
re-accumulate its `for: 2m` from scratch. **Restarting Prometheus to ship a
rule fix is itself a small, real detection outage** for whatever was
already in flight.

## Metrics

```promql
sum(increase(queue_messages_published_total{status="success"}[100m]))   # 37,284 (increase() correctly
sum(increase(queue_messages_consumed_total[100m]))                      #  2,693  sums across counter
                                                                         #  resets from 4 order-service
                                                                         #  restarts during this window -
                                                                         #  see the lesson below)
```

Outstanding backlog at the point the worker was restored: **~34,591
messages**.

## Logs

```logql
{job="pulseops", service="order-service", level="info"} | json | message="published order.created"
```
17,000+ matching lines across the incident window — the publish side never
stopped or slowed; only consumption did.

## Traces

Traces for `POST /api/orders` during this window show the `publish` span
completing normally with no downstream `worker` child span — the visible
signature of "accepted but never processed," directly in the waterfall,
compared to a healthy trace's `publish -> worker: order.created process`
parent/child relationship (Phase 7).

## Alert

| Alert | Delivered | Notes |
|---|---|---|
| `ServiceDown{job="worker"}` | **2026-09-12T15:52:32.194Z** | Correct, fast, as designed |
| `QueueBacklogGrowing` (buggy version) | **never** | The actual bug |
| `QueueBacklogGrowing` (fixed version) | **2026-09-12T16:38:35.752Z** | 16m10s after the fix was reloaded |

## Detection time (MTTD)

Two numbers, both real, both necessary:

```
MTTD (ServiceDown)        = 15:52:32.194 − 15:50:01.000 = 2m31.2s
MTTD (QueueBacklogGrowing, as originally shipped) = undefined - it never fired
MTTD (QueueBacklogGrowing, post-fix, from the fix's own reload) =
    16:38:35.752 − 16:22:25.796 (reload timestamp) = 16m9.96s
```

`ServiceDown` correctly told an on-call engineer "the worker is down" in
2m31s. It did **not** tell them "and a backlog of tens of thousands of
messages is building because of it" — that required either reading the
runbook's own warning about the worker (which exists, and says exactly
this) or the now-fixed alert. Before the fix, only the runbook's *prose*
carried that warning; no metric did.

## Investigation

`ServiceDown` pointed at the worker immediately. Confirming the *consequence*
— a growing backlog, not just a stopped process — required manually
querying `queue_messages_published_total` vs `queue_messages_consumed_total`
directly, which is exactly the gap the fixed alert closes.

## Root cause

Primary: the worker was stopped (the injected fault, as designed).
Secondary, and the more important finding: `QueueBacklogGrowing`'s
expression could not tolerate the consumed-side metric going absent, which
is precisely what happens when its source process is the one that's down.

## Mitigation

Restart the worker: `./scripts/restore-service.sh worker "curl -sf http://localhost:4003/health"`.

## Recovery

Worker restarted at **16:40:26Z**, healthy and consuming again by
**16:40:34Z**. Confirmed processing immediately via worker logs
(`order processed orderId=...`).

**Recovery is reported in two parts, deliberately not conflated:**

1. **The alert condition resolves quickly** once publish traffic stops:
   with load generators stopped, drain rate held steady at **4.17
   messages/sec**, `consumed > published` (0 new publishes), and the
   derived metric heads negative — the alert would clear once the 10-minute
   rate window rolls the old high-publish data out, which is itself an
   inherent ~10-minute lag baked into the alert's own window size, separate
   from Alertmanager's `group_interval`.
2. **The backlog itself does not drain in that time.** At the measured
   4.17/s steady-state drain rate against ~34,591 outstanding messages:

   ```
   ETA to zero backlog = 34,591 / 4.17/s ≈ 8,295s ≈ 2h18m
   ```

   This is a calculated projection from a real, measured, steady rate —
   not a fabricated number — and it is **not observed to completion** in
   this report, because waiting 2+ hours to watch a counter tick down adds
   no further evidence once the rate is established and confirmed stable.
   A real postmortem for an incident like this would report exactly this:
   the alert clearing tells you the bleeding has stopped, not that the
   patient has recovered.

## MTTD / MTTR

```
MTTD (ServiceDown, the alert that actually worked) = 2m31.2s
MTTD (QueueBacklogGrowing, as shipped)             = never (the finding)
MTTR (worker itself)   = 16:40:26 − 15:50:01 = 50m25s (a long incident, deliberately
                          left running to accumulate enough backlog to be measurable)
MTTR (queue stopped growing) = near-immediate once worker resumed (4.17/s > 0/s)
MTTR (queue fully drained)   = ~2h18m, calculated, not observed
```

## Classification

**SEV-3.** No user-facing failure at any point — orders were accepted
successfully throughout. The impact is a correctness/freshness problem
(orders stuck at `pending` far longer than intended) rather than an
outage, matching the runbook's own pre-existing severity call for a
worker outage.

## Lessons learned

1. **A metric that only exists on the failing component can vanish exactly
   when you need it most.** Any alert comparing two sides of a
   producer/consumer relationship needs to consider what happens when one
   side goes completely silent, not just degraded — `or vector(0)` is the
   fix, but the general principle is to ask "what does this expression
   evaluate to if this specific series is entirely absent?" for every
   alert that spans more than one target.
2. **Restarting Prometheus to ship a rule fix resets in-flight alert
   state.** A real, currently-firing alert's `for:` timer restarts from
   zero. If this had been `ServiceDown` mid-incident instead of a
   less-urgent backlog alert, that reset could have delayed a live page.
3. **Prometheus counters reset to zero on process restart**, and this
   incident's own order-service restarted four times (Incidents 003 and
   005 both redeployed it). The raw instant value of
   `queue_messages_published_total` after those restarts (17,418) *looked*
   like a reasonable number and was **wrong** — the true cumulative total
   across the incident, correctly computed via `increase()` over a window
   wide enough to span every reset, was 37,284. Never trust an instant
   counter value across a known restart; always use `increase()`/`rate()`.
4. **An alert resolving is not the same claim as "fully recovered."** This
   alert is specifically a *growth* detector; confirming it clears only
   confirms the backlog stopped getting worse. Reporting a calculated ETA
   from a measured rate, rather than either inventing a number or waiting
   out a multi-hour drain, is the honest middle ground.
