# SLIs, SLOs and Why These Numbers (Phase 9)

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

## What Phase 10 does with this

The SLIs above are ratios of good events to valid events, which is exactly
the shape an error budget needs:

```text
error budget = 1 - SLO target
budget consumed = (1 - SLI) / (1 - SLO target)
```

Phase 10 turns these into error budget and burn-rate calculations, and the
Executive Reliability Overview dashboard. Phase 11 turns burn rate into
alerts that fire on *budget consumption speed* rather than on raw error
rate.

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
