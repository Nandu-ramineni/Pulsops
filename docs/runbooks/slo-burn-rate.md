# Runbook: SLO error budget burn rate

**Alerts:** `AvailabilityErrorBudgetFastBurn`,
`AvailabilityErrorBudgetSlowBurn`, `AvailabilityErrorBudgetDrain`,
`LatencyErrorBudgetFastBurn`, `LatencyErrorBudgetSlowBurn`,
`LatencyErrorBudgetDrain`

## What this means

The error budget is being consumed faster than the SLO allows. Burn rate is
normalised so **1 = the budget lasts exactly one 30-day window**; the alert
threshold tells you how bad it is:

| Threshold | Budget spend | Tier |
|---|---|---|
| 14.4x over 1h | 2% of the month in one hour | page |
| 6x over 6h | 5% of the month in six hours | page |
| 3x over 1d | 10% of the month in a day | ticket |

Both a long and a short window must exceed the threshold, so this is not a
transient blip — it was bad enough to matter *and* it is still happening.

## Impact

- **Availability burn** — users are receiving 5xx from the gateway.
- **Latency burn** — requests are exceeding 250ms. Users experience this as
  sluggishness rather than failure, so it is easy to under-react to.

## Severity

SEV-2 by default. Escalate to SEV-1 if availability burn rate exceeds ~50x
(roughly a quarter of all requests failing) or the budget is already
negative.

## First checks (2 minutes)

1. Open the **Incident Investigation** dashboard. Start at *Service Up/Down*
   — if a service is down, stop here and use
   [service-down.md](service-down.md).
2. *Error Rate* panel — which service, and is it climbing or plateaued?
3. *Latency p95/p99* — a p99 moving while p95 stays flat means a subset of
   requests, usually one dependency or code path.
4. *Dependency Health* — whichever line is non-zero is very likely the cause.

## Investigate

**Which SLO, and how fast:**
```promql
slo:availability:burn_rate5m
slo:latency:burn_rate5m
slo:availability:error_budget_remaining_ratio
```

**Which endpoint is failing:**
```promql
sum by (route, status_code) (rate(http_requests_total{service="gateway",status_code=~"5.."}[5m]))
```

**Errors, with the request that caused them** — Grafana Explore, Loki:
```logql
{job="pulseops", level="error"}
```
Expand a line and click **TraceID → View trace** to see exactly which span
failed or was slow.

**Slow requests, straight from Tempo** (TraceQL):
```
{duration > 1s}
```

This is the query that found the AMQP reconnect problem documented in
`docs/slos.md` — worth running first for any latency burn.

## Known causes seen in this system

| Symptom in trace | Cause | Mitigation |
|---|---|---|
| `tls.connect` ~1s inside the request handler | AMQP connection re-established in-band; the startup warm-up does not cover later drops | Restart `order-service` to re-warm; the real fix is out-of-band reconnection handling |
| `pg-pool.connect` slow / `db_pool_connections{state="waiting"}` > 0 | Connection pool saturated | See [dependency-degraded.md](dependency-degraded.md) |
| 502s from gateway | An upstream is down | See [service-down.md](service-down.md) |

## Mitigation

Mitigate first, diagnose after. In rough order of preference:

1. **Roll back** if this began after a deploy. Fastest, safest.
2. **Restart the affected service** if it is a connection-state problem
   (the AMQP case above) — cheap and usually immediate.
3. **Shed load** if a single endpoint is responsible and can be degraded.

## Verify recovery

```promql
slo:availability:burn_rate5m   # should fall toward 0
sli:availability:ratio_rate5m  # should return to ~1
```

The 5m window takes a full 5 minutes to clear after the underlying problem
stops — the alert resolving is *lagging* confirmation, not the first sign.
The short-window half of the alert is what makes it resolve promptly at all.

## Afterwards

Record how much budget the incident cost, from
`slo:availability:error_budget_remaining_ratio` before and after. That number
is what turns "we had a blip" into a prioritisation decision. If the budget
went negative, the error budget policy in `docs/slos.md` applies: reliability
work takes priority over features until it recovers.
