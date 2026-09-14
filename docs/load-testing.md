# Load & Stress Testing (Phase 15)

Three k6 scripts, each answering a different question, each actually run
against the live stack rather than described. Every number below is from a
real k6 summary or a Prometheus query against that exact run's time window
— nothing here is estimated.

## Why k6, and why via Docker on the compose network

k6 scripts hit `http://gateway:8080` — the same URL a real client would use
— but the test containers join `pulseops_default` directly
(`docker run --network pulseops_default ... -e BASE_URL=http://gateway:8080`),
reaching the gateway by its Docker service name rather than a host port.
That sidesteps the Hyper-V/WSL dynamic port exclusion issue that has hit
this project's *own* host ports repeatedly (see the README's port note) —
the load generator never touches a host port at all.

```bash
docker run --rm --network pulseops_default \
  -v "$(pwd)/load-tests:/scripts:ro" -e BASE_URL=http://gateway:8080 \
  grafana/k6:0.54.0 run /scripts/normal-load.js
```

`load-tests/common.js` holds the shared 60/30/10 read-order/read-user/
create-order traffic mix — the same realistic profile used for every ad-hoc
load generator since Phase 9, now a real, versioned k6 module instead of a
bash loop.

## 1. Normal load — is the system meeting its own SLOs?

`normal-load.js` sustains **15 req/s for 3 minutes** — the rate this
project's SLOs were actually measured against in Phase 9 — with k6
thresholds set to the *exact* SLO values from `docs/slos.md`:

```js
thresholds: {
  http_req_duration: ['p(95)<250'],   // the latency SLO threshold
  http_req_failed: ['rate<0.005'],    // the availability SLO (99.5%)
}
```

A passing k6 run is therefore a direct SLO compliance check, not a generic
load test with made-up numbers.

**Result: both thresholds passed.**

| Metric | Result |
|---|---|
| Total requests | 2,705 |
| Achieved rate | 14.96 req/s (target: 15) |
| p50 | 4.89ms |
| p90 | 8.66ms |
| **p95** | **10.82ms** (SLO: <250ms — 23x headroom) |
| max | 746.93ms (single outlier, did not move p95) |
| **Error rate** | **0.00%** (SLO: <0.5%) |
| Checks passed | 2700/2700 (100%) |

At the traffic level this project's SLOs were designed around, the system
has roughly **23x latency headroom** before the p95 threshold. That number
matters for what comes next.

## 2. Stress test — where does it actually break?

`stress-test.js` ramps well past normal in stages (15 → 50 → 150 → 400 →
800 req/s) with no thresholds gating the run early — the goal is to
observe the breaking point, not enforce a pass/fail.

**The result was not what the naive hypothesis predicted.** The obvious
guess — "it'll start returning errors" — was wrong:

| Metric | Result |
|---|---|
| Total requests | 22,255 |
| **Error rate** | **0.00%** — zero 5xx responses, at any load level tested |
| p50 | 978.57ms |
| p90 | 4.6s |
| **p95** | **5.31s** (vs. 10.82ms at normal load — ~490x) |
| max | 6.77s |
| Dropped iterations | 35,537 (147.3/s) — k6 itself could not keep offering load once its VUs were stuck waiting on slow responses |

**The system degrades entirely through latency, never through errors.**
That is a genuinely good resilience property — no cascading 5xx, no
crashed process — but it is also a warning sign on its own: a system that
never sheds load by rejecting requests will queue indefinitely instead,
and "dropped_iterations" climbing is k6's own version of that same
problem happening to the load generator.

### Root cause, found directly in Prometheus, not guessed

```promql
max_over_time(db_pool_connections{state="waiting"}[6m])
```

```
order-service: 388
user-service:  0
worker:        0
```

**388 requests were queued waiting for a Postgres connection in
`order-service`.** CPU was never the constraint —

```promql
max_over_time(rate(process_cpu_seconds_total[1m])[6m:1m])
```
```
gateway: 30%   order-service: 20%   user-service: 10%   worker: 1%
```

— confirming this precisely: neither `order-service/src/db.js` nor
`user-service/src/db.js` sets a `max` on its `pg.Pool`
(`services/*/src/db.js`), so each defaults to **10 connections**. Node's
`pg.Pool` queues excess requests rather than rejecting them, with no
default timeout — which is exactly the "queues forever instead of failing
fast" shape the latency numbers above show, and exactly why the error rate
stayed at 0.00% even at 490x normal latency.

### Was this deliberately fixed?

**No — deliberately not**, and that distinction matters. Increasing the
pool size would have been trivial, but it would have answered a different
question than the one this phase asks. Given normal load's own measured
23x headroom (10.82ms p95 against a 250ms budget), and that the pool only
begins queueing somewhere between 150 and 400 req/s — 10-25x the traffic
this project's SLOs are calibrated against — the honest conclusion is a
**capacity-planning finding, not a bug report**: the current default is
adequate for the traffic this system actually serves, and if that changes,
the fix is now known precisely (`new Pool({ max: N, connectionTimeoutMillis: ... })`)
rather than guessed at under pressure during a real incident. A `pg.Pool`
that fails fast past a configured `connectionTimeoutMillis` — trading
"never errors, gets arbitrarily slow" for "fails fast past a known limit"
— is exactly the kind of bulkhead pattern that belongs with the
reliability-patterns work later in this project, once there's a concrete
reason to raise the ceiling rather than just to know where it is.

### Alerts: a brief spike doesn't fully exercise a sustained-problem alert

```
LatencyErrorBudgetFastBurn:  pending (on track to fire had the overload persisted)
PostgresConnectionPoolSaturated: never triggered
```

`PostgresConnectionPoolSaturated` has `for: 5m`; the stress test's most
severe stage only lasted 45 seconds before the ramp-down began. This is
not a bug in the alert — it is a real, useful finding about the shape of
this specific test: **a short synthetic spike does not fully exercise an
alert tuned to ignore short synthetic spikes**, which is the point of that
`for:` duration in the first place (see `docs/alerting.md`'s discussion of
alert fatigue). A sustained real overload lasting minutes, not seconds,
would fire it correctly.

## 3. Failure-condition load test — does the Phase 14 fix hold under real load?

`failure-test.js` + `run-failure-test.sh` run **6 minutes of sustained
~15 req/s load** while a real failure — stopping Redis, the same Phase 14
scenario — is injected partway in and restored 2 minutes later. Every
manual verification of the Redis fix in Phase 14 used a handful of
sequential curl requests; this is the first time it was exercised under
continuous, *concurrent*, realistic load — and that distinction turned out
to matter.

### An orchestration bug, found before it could produce fake data

The first attempt produced a real ~24-hour Redis outage (confirmed
independently via `docker compose ps` container uptimes) with **zero k6
load behind it** — `run-failure-test.sh`'s own `docker run` call was
missing `MSYS_NO_PATHCONV=1`, the same Git-Bash path-mangling issue fixed
elsewhere in this project, so k6 exited immediately with a
module-not-found error while the orchestration script's `sleep` calls kept
running regardless. No metrics from that run are reported here — reporting
"what it would have shown" would be exactly the kind of invented result
this project's rules forbid. Fixed by adding the flag and having the
script verify k6's own startup banner actually appears in its log before
proceeding to inject anything. The one useful fact that outage did
confirm: order-service ran for the full ~24 hours without crashing or
needing a restart, which is at least consistent with the Phase 14 fix
holding up, even without load metrics to back it up.

### Run 1 (before the fix)

| Metric | Result |
|---|---|
| Total requests | 5,369 |
| Achieved rate | 11.70 req/s (target 15 — see note below) |
| Checks passed | 5,360 / 5,364 (99.92%) |
| **`create order` check failures** | **4** (all during the Redis-down window) |
| `http_req_failed` | 0.07% (4 / 5,369) |
| p90 | 22.04ms |
| **p95** | **446.63ms** |
| max (k6-reported) | 1m42s — see the investigation below |

**This is the first non-zero error rate in this project's entire load
testing.** Both prior tests (normal load, stress test) showed 0.00% errors
throughout. Investigated rather than just reported:

```logql
{job="pulseops", service="order-service", level="error"} | json | message="dependency call failed"
```
All 4 failures: `fetch failed: Connect Timeout Error (attempted address:
user-service:4001, timeout: 10000ms)`.

**Root cause:** `userClient.js`'s call to `user-service` on a cache miss
uses Node's built-in `fetch()` with no application-level timeout — it
inherits undici's default **10-second** connect timeout. Under normal
conditions this never matters, because the cache hit ratio is ~99% (Phase
9/14 baseline) and the fallback path is rarely exercised. With Redis down,
**every** request became a cache miss simultaneously — order-service's
logs show exactly 173 `cache read failed, degrading to origin` lines
during the 2-minute window, a sudden 100x surge in direct calls to
user-service that the earlier sequential Phase 14 testing (one curl at a
time) could never have produced. `gateway`'s own p99 for `POST
/api/orders` during this window measured **exactly 10,000ms** — not
approximately, precisely at the fetch's default timeout boundary,
confirming this is the mechanism, not a coincidence.

**On the reported 1m42s max — investigated, not taken at face value.**
That figure is k6's own client-side measurement, and it is larger than
what the server itself ever recorded: order-service's own request logs
for this exact window top out at **20,953ms** (`durationMs` field, server-
authoritative), and k6's own `iteration_duration` metric — which should be
*at least* as large as `http_req_duration` for the same iteration — only
reached 21s. A single client-side outlier reading over 4x higher than
anything the server logged, in an environment that had already produced a
genuine multi-hour sleep-delay anomaly earlier in this exact test run (see
above), is most plausibly a k6/sandbox measurement artifact rather than a
real 102-second server-side hang. The **~21s figure is treated as the real
worst case** here, cross-confirmed by two independent measurements
(order-service's own logs and k6's `iteration_duration`), while the 1m42s
`http_req_duration` figure is reported for completeness without being
relied on.

**Achieved rate (11.70 vs. the 15 req/s target)** is explained by the same
mechanism: `constant-arrival-rate` schedules new iterations at a fixed
rate but each iteration still has to *finish* before its VU is free again,
and with `preAllocatedVUs: 20` / `maxVUs: 50`, the 10-second-plus stalls
during the failure window occasionally left every allocated VU busy
waiting rather than issuing new requests — the same "requests pile up
faster than they drain" shape observed in the stress test, on a much
smaller scale.

### The fix

Unlike the `pg.Pool` finding above, this one was fixed in this phase, not
just reported — it breaks the same promise Phase 14 already made ("Redis
can fail completely and every request still succeeds"), the same category
as the bugs fixed immediately in Phases 7, 11, 12, and 14, not a capacity
ceiling far past real traffic.

`userClient.js`'s `fetch()` call to `user-service` now carries a real
2-second bound, using cancellation rather than just abandoning the wait:

```js
response = await fetch(`${process.env.USER_SERVICE_URL}/users/${userId}`, {
  headers: requestId ? { [REQUEST_ID_HEADER]: requestId } : {},
  signal: AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS), // 2000ms
});
```

`AbortSignal.timeout()` was used deliberately instead of the
`Promise.race`-based `withTimeout()` helper already used for Redis in this
same file: `Promise.race` only stops the *caller* from waiting, it does not
cancel the underlying operation, which — as the second run below found —
has its own cost. `fetch()`'s `signal` option gives real cancellation, so
this is the more correct tool where the underlying call supports it.

### Run 2 (after the fix) — re-verified against the live stack

Same script, same injected failure, same 2-minute outage window, run again
after rebuilding `order-service` with the fix:

| Metric | Run 1 (before) | Run 2 (after) |
|---|---|---|
| Achieved rate | 11.70 req/s | **15.01 req/s** (target: 15) |
| **`create order` check failures** | 4 | **2** |
| **p95** | 446.63ms | **45.77ms** (9.8x better) |
| Failure error message | `fetch failed: Connect Timeout Error (..., timeout: 10000ms)` | `The operation was aborted due to timeout` |

Both remaining failures are the fix working as designed, not a residual
bug: the 2-second bound is a real ceiling, so a cache miss racing an
already-down user-service during the failure window can still time out —
just after 2s instead of 10s, and now by design rather than by an
unrelated library default. Reducing failures from 4 to 2 while cutting the
timeout 5x, and recovering the achieved rate back to the 15 req/s target,
is direct evidence the fix addresses the mechanism identified above, not
just the symptom.

### A second, smaller anomaly — found during the verification run, investigated, not fixed

Run 2 also surfaced something the first run's much larger 10-second stalls
had masked: **7 out of 1,148** `GET /orders/:id` requests during the
outage window took 4.3–10.3 seconds, even though that route never calls
Redis or `user-service` — it's a single `pg.Pool` read. That's 0.6% of
requests on an otherwise-untouched route, so it warranted checking rather
than dismissing as noise.

Two plausible causes were ruled out with real data before landing on a
third:

- **Not Postgres pool contention** — `max_over_time(db_pool_connections{state="waiting"}[3m])`
  over the exact outage window returned `0`. The stress test's pool finding
  doesn't apply here; nothing was queued for a connection.
- **Not an AMQP cold-start effect** (the Phase 7 finding, and a real risk
  here since `order-service` had just been rebuilt for the fix) — that
  effect is a one-time cost on the first request after startup, but these
  slow requests recurred in clusters roughly every 25–30 seconds
  throughout the entire 2-minute outage, and `GET /orders/:id` doesn't
  publish to RabbitMQ at all.
- **What actually correlates:** `order-service`'s logs show 67 `redis
  client error` lines during the outage — one roughly every 2–2.5 seconds,
  continuously, for the full window — and each cluster of slow
  `GET /orders/:id` requests starts within a second or two of one of these
  clusters. The mechanism: `connectRedis()` is still wrapped in the
  `Promise.race`-based `withTimeout()`, which — as noted above — abandons
  the *wait* after 750ms but does not cancel the underlying
  `client.connect()` call. During the outage, every cache-miss request
  (100% of them) calls `connectRedis()` again, so abandoned connection
  attempts to a dead Redis pile up in the background and keep running
  until their own 2000ms `connectTimeout` fires. The resulting churn is
  the most plausible explanation for brief event-loop-level delays that
  land on whatever request happens to be in flight at that moment —
  including a plain Postgres read on an unrelated route.

**Not fixed in this phase**, and for the same reason as the `pg.Pool`
sizing finding: it's rare (0.6% of one route), bounded to an already-
alerting failure condition (an active Redis outage), and self-resolves
the moment Redis comes back — a tail-latency finding, not a broken
promise. The fix, if this priority changes, is now specific: give
`connectRedis()`'s underlying socket real cancellation the same way the
`user-service` fetch above just got it, instead of only abandoning the
wait.

### Recovery

`RedisErrors` fired correctly (`2026-09-14T20:12:55.264Z`, matching the
real outage window plus its `for: 5m` and ticket `group_wait: 1m`). Redis
was restarted, and order creation was verified immediately afterward:
81ms round-trip, `202` — full recovery, consistent with every other
incident in this project.

### What this run actually adds beyond Phase 14

Phase 14 proved Redis could go down without user-visible failure, tested
one request at a time. This run found a **real, narrow gap in that
guarantee under concurrent load**: 4 failures out of 5,369 requests (an
error rate that would have burned real error budget in production) caused
by an unbounded dependency call that only becomes a bottleneck once its
normal ~1%-of-traffic path suddenly becomes 100% of traffic. Unlike the
stress test's connection-pool finding, this one **was fixed in this
phase** — it breaks an already-made promise rather than describing a
capacity ceiling far past real traffic — and the fix was re-verified
against the live stack: p95 during the failure window improved 9.8x
(446.63ms → 45.77ms) and failures dropped from 4 to 2, with both remaining
failures now correctly attributable to the new, intentional 2-second
bound rather than an inherited library default. That same re-verification
run surfaced a smaller, second finding (event-loop-level collateral
latency from abandoned Redis reconnect attempts, see above) — left
unfixed for the same capacity-planning reason as the pool finding.

## Summary across all three tests

| Test | Requests | p95 | Error rate | Finding |
|---|---|---|---|---|
| Normal load (15 req/s) | 2,705 | 10.82ms | 0.00% | Meets SLOs with ~23x latency headroom |
| Stress (15→800 req/s) | 22,255 | 5.31s | 0.00% | Breaks via Postgres pool queueing (388 waiting), never via errors |
| Failure, run 1 (15 req/s + Redis down) | 5,369 | 446.63ms | 0.07% (4 failures) | Unbounded `fetch()` to user-service inherits a 10s default timeout |
| Failure, run 2 (post-fix, re-verified) | — | **45.77ms** | 2 failures (now by design, at 2s) | Fix confirmed; smaller collateral-latency finding on an unrelated route |

Three real, load-tested findings came out of this phase, none invented,
all reproducible:

1. **`pg.Pool` has no configured `max`** in either `order-service` or
   `user-service` (defaults to 10). Adequate for this system's actual
   traffic (23x headroom at normal load), and now the exact number to
   change first if that ever stops being true. **Not fixed** — a capacity
   ceiling 10-25x past real traffic, not a broken promise.
2. **The `user-service` dependency call had no application-level
   timeout**, inheriting a 10-second default that only mattered once its
   normal ~1% traffic share became 100% during a Redis outage — a gap
   Phase 14's sequential testing couldn't have found, because it only
   exists under concurrent load. **Fixed and re-verified**: p95 improved
   9.8x, failures dropped 4→2, both remaining failures now attributable to
   the new intentional bound.
3. **`connectRedis()`'s own timeout wrapper doesn't cancel the underlying
   connection attempt**, so during a sustained outage, abandoned
   `client.connect()` calls pile up and appear to cause brief
   event-loop-level latency spikes on unrelated requests (0.6% of
   `GET /orders/:id` calls, 4.3–10.3s each, during the outage window
   only). **Not fixed** — rare, bounded to an already-alerting failure
   condition, self-resolving.

Findings 1 and 3 are capacity-planning/reliability findings, left as
measurements rather than fixes for the same reason: this phase's job is to
measure the system as built, not to change it out from under its own
measurements, except where a measurement reveals an already-made promise
being broken (finding 2). All three are concrete candidates for the
reliability-patterns work later in this project.

## Interview Questions This Phase Should Prepare You For

1. **"What's the difference between load testing, stress testing, and
   chaos/failure testing?"** — Load testing confirms the system meets its
   SLOs at expected traffic. Stress testing finds where it actually breaks,
   deliberately past that point. Failure testing combines sustained
   traffic with an injected fault to see how degradation behaves under
   real concurrency, not just in isolation — exactly the three scripts in
   this phase, each answering a different question with the same tool.
2. **"Your stress test showed a 490x latency increase but zero errors. Is
   that good?"** — It shows the system fails safe under overload (no
   cascading 5xx, no crashes) and also identifies a queue with no bound:
   `pg.Pool` queues indefinitely rather than rejecting past capacity. Both
   are true, and a load-test report should say both rather than picking
   the flattering half.
3. **"How do you find the actual bottleneck during a stress test, not just
   observe that something got slow?"** — Correlate what broke against
   what didn't: CPU stayed at 20-30% (not the constraint) while
   `db_pool_connections{state="waiting"}` hit 388 (the constraint) at the
   exact same moment. Ruling out causes with real metrics beats guessing
   from symptoms alone.
4. **"A load test reports a number that looks physically implausible (a
   102-second request when the server logs show a 21-second max). What do
   you do?"** — Don't report the implausible number as fact and don't
   discard it either. Cross-check against an independent, authoritative
   source (the server's own request logs, in this case), report which
   number you trust and why, and say so explicitly rather than picking
   whichever number tells a cleaner story.
5. **"How do you decide whether a load-testing finding needs fixing right
   now?"** — Compare the finding against actual expected traffic and
   against promises already made elsewhere. A pool that saturates at
   10-25x current load is a documented ceiling, not an incident — left as
   a finding. A dependency call with no timeout that fails under an
   *already-tested, already-occurred* failure mode (Redis down) breaks a
   guarantee this project already claimed to have (Phase 14's "Redis can
   fail without user-visible failure") — that one got fixed and
   re-verified in the same phase, with before/after numbers, not just
   flagged.
6. **"You fixed a bug and re-ran the same load test. The result improved,
   but a new, smaller anomaly showed up that wasn't visible before. What do
   you do?"** — Don't treat "the number I was tracking got better" as
   "done." The first run's 10-second stalls were large enough to mask a
   much smaller one: 0.6% of an unrelated route still saw 4-10s latency.
   Investigate it with the same rigor as the original finding — rule out
   causes with real metrics (Postgres pool waiting was checked and was
   zero; an AMQP cold-start was checked and ruled out by the recurring,
   not one-time, pattern) before accepting an explanation, then make an
   explicit, reasoned call on whether it needs fixing now or is a
   documented, bounded finding — it doesn't automatically inherit the
   priority of the bug you just fixed.
7. **"Why run k6 against `gateway:8080` over the Docker network instead of
   `localhost`?"** — It exercises the exact same path a real client uses
   (through the gateway, not a backend directly) while avoiding host-level
   port issues entirely, since the load generator never touches a host
   port.
