# SLIs, SLOs, Error Budgets and Burn Rates (Phases 9-10)

Every target in this document is derived from measurements taken against
this stack. Nothing here is copied from a reference architecture. Where a
number is uncertain, or where the observation window is too short to justify
a tighter target, that is stated rather than hidden.

## The three terms, briefly

- **SLI** — Service Level *Indicator*. A measurement of one aspect of
  service quality, shaped as `good events / valid events`.
- **SLO** — Service Level *Objective*. A target for an SLI over a window
  ("99.5% of requests succeed, measured over 30 days"). Internal.
- **SLA** — Service Level *Agreement*. An SLO with a contractual
  consequence. **PulseOps deliberately has no SLA**: there is no customer
  and no penalty clause, and inventing one would be theatre. An SLA is
  normally set *looser* than the internal SLO so engineering has room to
  react before money is involved.

## Where these are measured, and why it matters

**All SLIs are measured at the gateway.** That is the boundary a user
actually experiences. Measuring inside `order-service` would miss gateway
failures, proxy overhead, and anything that breaks before a request ever
reaches a backend — a service can report a perfect success rate while every
user gets a 502 from the layer in front of it.

The per-service RED metrics from Phase 4 still exist and are still useful,
but for *diagnosis*, not for judging whether we met our promise.

## The measured baseline

Captured 2026-09-06 against the full stack, ~5.1 req/s sustained over a
read-heavy mix (60% order reads, 30% user reads, 10% order creates),
approximately 1,200 requests.

| Measurement | Value |
|---|---|
| Availability (non-5xx / total) | **100%** — zero 5xx observed |
| Latency p50 / p95 / p99 (all traffic) | **6.0ms / 21.7ms / 41.5ms** |
| Reads `GET /api/users` p50 / p95 / p99 | 5.3ms / 12.8ms / 24.9ms |
| Reads `GET /api/orders/:id` p50 / p95 / p99 | 6.1ms / 21.6ms / 31.5ms |
| Writes `POST /api/orders` p50 / p95 / p99 | 15.2ms / 33.0ms / **4045ms** |
| Requests under 250ms (steady state) | **99.72%** |
| Requests under 250ms (including outliers) | 99.54% |
| Requests over 250ms, lifetime | **4 out of 1,188** — all `POST /api/orders` |

Two things in that table drive every decision below.

**The distribution is extremely tight, then has a cliff.** Going from a
100ms threshold to a 1s threshold buys only 0.12 percentage points
(99.43% → 99.54%). There is no gradual tail here: requests are either fast
(tens of milliseconds) or they are seconds slow. Widening the latency
threshold therefore buys almost nothing — which is a strong argument for
setting it tight and treating the outliers as budget spend rather than
inflating the threshold until they disappear.

**The write path has a real, non-startup outlier problem.** A p99 of 4045ms
against a p95 of 33ms is not a warm-up artifact — `order-service` had been
running 28 hours. Querying Tempo for `{duration > 1s}` returned four traces,
all `POST /api/orders` (3946-4260ms), and the span breakdown showed:

```text
[order-service] request handler - /orders   3079.6ms
  [order-service] tls.connect                1009.6ms   <-- AMQP reconnect
  [order-service] pg.query:INSERT               3.4ms       inside the request
```

The AMQP connection is being re-established *in-band*, inside the request.
Phase 7 added a startup warm-up, but nothing handles the connection dropping
later — which CloudAMQP's free tier does to idle connections. This is a
known, identified threat to the latency SLO and is recorded as such below
rather than being smoothed away.

## The SLIs

### 1. Availability

```promql
sum(rate(http_requests_total{service="gateway",status_code!~"5.."}[window]))
/
sum(rate(http_requests_total{service="gateway"}[window]))
```

**Request-based, not time-based.** "Was the service up?" requires defining
"up" and a probe cadence, and it collapses a partial failure into a binary.
A ratio over real user traffic degrades honestly: if half of requests fail,
the SLI reads 50%, not "down".

**4xx is excluded from the failure set.** A client sending a malformed body
or requesting a row that does not exist is not our outage. Counting it as
one would let a badly-behaved caller burn our error budget — the same
reasoning behind the 400-vs-500 fix made earlier in this project. The load
baseline above included legitimate 404s, and they correctly did not count
against availability.

### 2. Latency

```promql
sum(rate(http_request_duration_seconds_bucket{service="gateway",le="0.25"}[window]))
/
sum(rate(http_request_duration_seconds_count{service="gateway"}[window]))
```

**A proportion, not a percentile.** "p95 < 250ms" is the more familiar
phrasing and it is the wrong shape for an SLO: percentiles cannot be
averaged or summed across windows, so they do not compose into an error
budget. `good events / valid events` does, and that is what makes the
multi-window burn-rate alerting in Phase 10 possible at all.

**The threshold must be an existing histogram bucket boundary.** There is no
interpolation in this query — `le="0.25"` matches a real bucket. This is why
250ms was picked from the buckets defined in Phase 4 rather than choosing a
round number first and discovering it was unmeasurable.

### 3. Throughput — recorded, but deliberately not an SLO

Throughput is *demand*, not reliability. The service does not promise a
request rate; the request rate is imposed on it. It is recorded
(`traffic:requests:rate5m`) for two reasons: a ratio computed over three
requests is not meaningful, and a sudden drop in traffic is itself a symptom
worth seeing next to the SLIs.

## The SLOs, and why these numbers

### Availability: 99.5% over 30 days

**Measured: 100%. Target: 99.5%. That gap is deliberate.**

- **The observation window is short.** Roughly 40 minutes of real traffic.
  Claiming 99.9%+ from that is not evidence, it is optimism. An SLO derived
  from a thin sample should be conservative and tightened later.
- **Nothing in this architecture is redundant.** One Postgres, one instance
  of every service, a free-tier cloud broker. There is no failover. A single
  container restart during a deploy drops in-flight requests.
- **The budget has to survive routine operations.** 99.5% allows 3.6 hours
  per 30 days; 99.9% allows 43.2 minutes. With no HA, a handful of deploys
  and one bad incident would consume a 43-minute budget entirely, leaving
  the SLO permanently violated and therefore ignored.

An SLO that is always breached generates alert fatigue; one that is never
approached generates nothing. 99.5% is set to be *achievable but not free*.

**This should be revisited after several weeks of data**, and tightened
toward 99.9% once there is redundancy to justify it. Recording the intent to
revisit is part of the design, not an admission of weakness.

### Latency: 99% of requests under 250ms, over 30 days

- **250ms is roughly 6x the measured p99 (41.5ms)**, so the SLO does not
  need redefining the moment traffic grows. It is also near the point where
  an interaction stops feeling instant, so it is defensible from the user's
  side, not just the histogram's.
- **99% against a measured 99.72%** leaves about 0.7 percentage points of
  headroom — real but not generous.
- **The AMQP reconnect outliers are expected to consume that headroom.**
  That is the point: the budget makes an ongoing reliability gap visible and
  quantified instead of being an anecdote. If it consumes too much, the fix
  is to handle reconnection out-of-band, not to loosen the SLO.

### One combined latency SLO, with a known caveat

Reads and writes are measurably different journeys — reads have no slow tail
at all, writes carry the multi-second outliers. Best practice would give each
journey its own SLO.

A single combined SLO is used for now, with the read and write ratios
**recorded separately** (`sli:latency_read:*`, `sli:latency_write:*`) so
they can be split without waiting to accumulate history. The trade-off is
stated plainly: a combined SLO means a shift in traffic mix moves the SLI
without any real change in service quality. With writes at ~10% of traffic,
that distortion is currently small; if the mix shifts materially, split them.

## Known threats to these SLOs

| Threat | Effect | Status |
|---|---|---|
| AMQP connection re-established in-band | 3-4s outliers on `POST /api/orders` | **Identified via tracing, not yet fixed** — needs out-of-band reconnection handling |
| No redundancy anywhere | Any restart drops requests | Accepted; reflected in the 99.5% target |
| Single Postgres | Total outage if it fails | Accepted for this project's scope |
| Broker-native queue depth unobservable | Backlog can grow unseen | Known gap since the move to CloudAMQP |

---

# Error Budgets and Burn Rates (Phase 10)

## What an error budget is, and why it exists

An SLO of 99.5% is also a statement that **0.5% of requests are allowed to
fail**. That allowance is the error budget.

The reason it exists is not permissiveness, it is negotiation. Reliability
and change velocity are in direct tension: the only perfectly reliable
system is one nobody touches. Without an agreed budget, that tension gets
resolved by whoever argues hardest — product pushes to ship, ops pushes to
freeze, and the decision is political.

An error budget replaces the argument with arithmetic. Below budget, the
team has *earned* the right to take risks: ship faster, run experiments,
tolerate a rough edge. Over budget, that right is spent and reliability work
takes priority. Nobody has to win a debate.

It also reframes what an incident costs. "We had a blip on Tuesday" becomes
"that blip consumed 40% of the month's allowance", which is a number a
product manager and an engineer can reason about together.

## The arithmetic

```text
error budget          = 1 - SLO target
budget consumed ratio = (1 - SLI) / (1 - SLO target)
budget remaining      = 1 - budget consumed
```

At a 99.5% target the budget is 0.005. If the measured SLI is 99.4%, then
`(1 - 0.994) / 0.005 = 1.2` — 120% consumed, i.e. 20% overspent.

**Budget remaining is deliberately not clamped at zero.** A flat 0 hides how
far past the line you are; −20% is the number that should stop a risky
deploy. The dashboard gauge extends below zero for exactly this reason.

### Why the budget is counted in requests, not minutes

With a request-based SLI, the budget *is* a number of failed requests:

```text
allowed failures = total requests in window x (1 - SLO target)
```

"43 minutes of downtime per month" is the familiar phrasing, but it only
holds if traffic is uniform. Ten minutes of failure during peak costs far
more budget than ten minutes at 3am, and a request-based budget captures
that automatically. The dashboard therefore shows failed-vs-allowed
requests, with the minutes framing avoided rather than approximated.

## Burn rate: the speed of spending

Budget remaining tells you where you are. Burn rate tells you how fast you
are moving, and it is the number worth alerting on.

```text
burn rate = (1 - SLI over window) / (1 - SLO target)
```

It is normalised so that **burn rate 1 means the budget lasts exactly one
SLO window**. Higher means faster:

| Burn rate | Budget gone in | Meaning |
|---|---|---|
| 1 | 30 days | Spending exactly as planned |
| 2 | 15 days | Twice as fast as sustainable |
| 6 | 5 days | 5% of budget in 6 hours |
| 14.4 | ~50 hours | 2% of budget in 1 hour |

The 14.4 and 6 figures are the standard page-worthy thresholds, and they are
not arbitrary: 14.4 is chosen so that one hour of burning consumes 2% of a
30-day budget, and 6 so that six hours consumes 5%.

### Why multiple windows

No single window works. A 5-minute window detects a severe outage almost
immediately but fires on every transient blip. A 6-hour window is stable but
would let a total outage run for hours before saying anything.

The standard answer, which Phase 11 implements, is to require a **long
window and a short window to agree**: the long window answers "has enough
budget been burned to matter?", and the short window answers "is it *still*
burning right now?". Requiring both means an alert fires on real sustained
problems and resolves promptly once the problem stops, rather than
smouldering for hours after recovery.

That is why `slo:*:burn_rate5m` through `burn_rate1d` are all recorded here
even though nothing consumes them yet.

## What happens when the budget is exhausted

A budget with no consequence is decoration. The policy for this project:

| Budget remaining | Posture |
|---|---|
| > 50% | Normal. Ship freely, take reasonable risks. |
| 25-50% | Caution. Deploys continue; risky changes get a second pair of eyes. |
| 0-25% | Slow down. Feature work continues but reliability fixes jump the queue. |
| **< 0%** | **Feature freeze.** Only reliability fixes, critical security patches, and rollbacks ship until the budget recovers. |

The freeze is not a punishment; it is the mechanism that stops a team from
borrowing indefinitely against future reliability. Note that it also has an
expiry: because the SLI is a trailing 30-day window, a bad month ages out on
its own, and the budget recovers without anybody granting an exception.

If the budget is repeatedly exhausted, the honest conclusion is usually that
the SLO is wrong or the architecture cannot support it — not that the team
needs to try harder. In this project's case, the single-instance
architecture is a known constraint (see the threats table above).

## Demonstrated, not just calculated

The rules were validated by deliberately breaking the system rather than
trusting the arithmetic. `user-service` was stopped while traffic continued,
so the gateway returned 502s on user reads and 500s on order creates that
missed cache:

| | before | during outage | after recovery |
|---|---|---|---|
| Availability SLI (5m) | 1.0000 | **0.9826** | recovering |
| Availability burn rate (5m) | 0.0000 | **3.4775** | elevated |

The burn rate math checks exactly: `(1 - 0.9826) / 0.005 = 3.48`. At that
speed the 30-day budget would be gone in roughly 8.6 days.

That single injected incident was enough to push the availability budget
negative:

```text
availability SLI (30d window)  0.9948   -> below the 0.995 target
error budget remaining        -3.28%    -> overspent
failed requests                   51
failed requests allowed         49.6
```

The Executive dashboard correspondingly shows **availability MISSING** and
**latency MET** (99.25% against a 99% target, 25% of budget remaining). This
is a real breach produced by a real failure, not a mocked-up screenshot.

## A Prometheus bug worth knowing about

The budget recording rules were first written with `interval: 5m`, on the
reasoning that a 30-day budget does not need recalculating every 30 seconds.
Every rule reported `health: ok`, and the series still intermittently
returned **no data**.

The cause is that Prometheus resolves an instant query by looking back up to
`--query.lookback-delta` (5 minutes by default) for the most recent sample.
A rule evaluated every 5 minutes produces samples exactly 5 minutes apart —
right on that boundary. Any evaluation delay pushes the newest sample just
outside the window and the series vanishes, so dashboard panels flicker
between a value and "No data" with nothing logging an error.

The fix is to keep any recording rule's interval comfortably below the
lookback delta; these now run at `interval: 1m`. The general lesson: **rule
health being `ok` only means the expression evaluated, not that anything can
read the result.**

## What Phase 11 does with this

Phase 11 turns the recorded burn rates into Prometheus alert rules using the
multi-window approach described above, so alerts fire on budget consumption
*speed* and user impact rather than on raw error counts or CPU thresholds.

## Interview Questions This Phase Should Prepare You For

1. **"How did you choose 99.5%?"** — From measurement plus architecture, not
   convention. Measured 100% over a short window, then set the target below
   it because the sample was thin and nothing is redundant. The number is
   defensible in both directions: what it permits (3.6h/month) and why a
   tighter one would be dishonest.
2. **"Why not just alert on p95 latency?"** — Percentiles do not compose.
   You cannot average p95 across windows, so you cannot build an error
   budget or a burn rate from it. Ratios of good to valid events compose
   trivially.
3. **"Why exclude 4xx from availability?"** — They are the caller's errors.
   Counting them means a client with a bad integration can burn your budget
   and page your on-call for a fault that was never yours.
4. **"What's the difference between an SLO and an SLA?"** — Consequence. An
   SLA has a contractual penalty and is set looser than the internal SLO, so
   engineering gets to react before the business is exposed.
5. **"Your SLI says 100% but you only have 40 minutes of data. Is that a
   good SLO?"** — No, and that is why the target is conservative. Sample
   size is part of SLO design; a ratio over a small denominator is not
   evidence of reliability.
6. **"Why measure at the gateway rather than in each service?"** — The SLI
   should reflect user experience. Per-service metrics are for diagnosis.
   A backend can look perfectly healthy while the edge in front of it
   returns 502s to everyone.
7. **"Should every service have an SLO?"** — No. SLOs belong on user-facing
   journeys. Putting one on every internal component produces a wall of
   targets nobody can act on, and encourages alerting on causes rather than
   symptoms.
8. **"What is an error budget actually for?"** — Replacing an argument with
   arithmetic. Reliability and velocity are in tension, and without an
   agreed number that tension is settled by whoever argues hardest. The
   budget makes "can we ship this?" a question with a factual answer.
9. **"What is a burn rate of 14.4 and where does that number come from?"** —
   It is normalised consumption speed: burn rate 1 exhausts the budget in
   exactly one SLO window. 14.4 is chosen so that one hour at that rate
   burns 2% of a 30-day budget, which is the standard fast-burn page
   threshold.
10. **"Why do burn-rate alerts use two windows?"** — A short window alone is
    noisy; a long window alone is slow to fire and slow to clear. Requiring
    a long window (has enough budget burned to matter?) and a short window
    (is it still burning?) to agree gives fast detection, few false alarms,
    and prompt resolution after recovery.
11. **"Your budget says minutes of downtime. Is that right?"** — Only if
    traffic is uniform. With a request-based SLI the budget is a count of
    failed requests, which correctly makes an outage at peak cost more than
    the same duration overnight.
12. **"Your dashboard shows a 30-day budget but Prometheus has two days of
    data. Is that number real?"** — No, and it should say so. The ratio is
    valid over observed traffic, but the absolute allowance is not a true
    month. Stating the limitation is part of the deliverable; presenting it
    as a month would be fabrication.
