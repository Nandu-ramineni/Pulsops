# Dashboards (Phase 17)

Four Grafana dashboards, all provisioned as versioned files
(`observability/grafana/dashboards/*.json`) rather than clicked together in
the UI — the same reasoning as
[observability.md's interview answer on this](observability.md#interview-questions-this-phase-should-prepare-you-for):
a dashboard that only exists in one Grafana instance's database isn't
reviewable in a PR, isn't reproducible on a fresh environment, and is easy
to accidentally edit mid-incident. Every panel below was actually opened
in a browser against the live stack and checked against real Prometheus
queries during this phase — not assumed correct from the JSON.

| Dashboard | URL | Built | Purpose |
|---|---|---|---|
| [Service Overview](#1-service-overview) | `/d/pulseops-service-overview` | Phase 5 | RED metrics per service — the first stop for "is anything wrong" |
| [Dependencies](#2-dependencies) | `/d/pulseops-dependencies` | Phase 5 | Postgres/Redis/RabbitMQ/downstream-call health — narrows "unhealthy" to "unhealthy because of what" |
| [Incident Investigation](#3-incident-investigation) | `/d/pulseops-incident-investigation` | Phase 8 | The actual investigation path: up/down → error/latency → dependency → logs → trace |
| [Executive Reliability Overview](#4-executive-reliability-overview) | `/d/pulseops-executive-reliability` | Phase 10 | SLO compliance and error-budget burn — "how much of our promise is left" |

All four are auto-provisioned on `docker compose up` (see
`observability/grafana/provisioning/dashboards/`, `updateIntervalSeconds: 30`,
so an edited JSON file is picked up live without a restart — used directly
while fixing the labeling bug documented below).

## 1. Service Overview

Panels: **Request Rate, Error Rate, Latency (p50/p95/p99), Active
Requests, CPU, Memory (RSS), Warnings & Errors (Loki)** — 7 panels, with a
`$service` template variable (gateway / user-service / order-service;
worker has no HTTP surface and is naturally excluded, since the variable
is populated from `label_values(http_requests_total, service)`).

The first stop for "is anything wrong" — six RED/resource timeseries plus
a live log panel, per service. See
[observability.md's Phase 5 section](observability.md#prometheus--grafana-phase-5)
for the original build notes, including the cosmetic Error Rate y-axis
auto-scaling bug found and fixed while verifying panels in the browser
back then — the same practice this phase repeated on the fourth dashboard.

## 2. Dependencies

Panels: **PostgreSQL Query Duration (p95), PostgreSQL Connection Pool,
Redis Cache Hit Ratio, Redis Operation Latency (p95), user-service
Dependency Call Latency (p95), Queue Backlog Trend (derived proxy), Worker
Processing Rate** — 7 panels, no template variable (each panel is scoped
to the one service that owns that dependency).

Verified live during this phase against a cold-started stack: PostgreSQL
Query Duration showed a real ~400ms spike on `order-service`'s first few
queries (fresh connection-pool establishment) dropping to single-digit
milliseconds within about 30 seconds, and Redis Cache Hit Ratio climbed
from 0% to ~100% over the same window as the cache actually warmed —
exactly the shape a cold start should produce, and a useful sanity check
that this dashboard reflects reality rather than a static mock.

## 3. Incident Investigation

Panels: **Service Up/Down, Error Rate, Latency p95/p99, Dependency Health
(failures/sec), Dependency Latency p95, Errors & Warnings (click TraceID
to open the trace)** — 6 panels, `$service` variable, laid out
top-to-bottom as the actual investigation order (see
[observability.md's Phase 8 section](observability.md#correlating-the-three-pillars-phase-8)
for why: check Up/Down first, since every panel below it looks like "no
errors" for a service that's stopped reporting entirely).

This is the dashboard every [runbook](runbooks/README.md#where-to-look-in-order)
and every [postmortem](postmortems/README.md) in this project points to
first. The "click TraceID" pivot (Loki derived field → Tempo) is the
mechanism [observability.md documents in detail](observability.md#what-is-wired-to-what),
including two real bugs found while wiring it up in Phase 8.

## 4. Executive Reliability Overview

Panels: **Availability SLO — status, Availability (SLO window), Availability
— error budget remaining, Availability budget — requests, Latency SLO —
status, Latency SLI (under 250ms), Latency — error budget remaining,
Traffic, Availability burn rate — multi-window, Latency burn rate —
multi-window, Error budget remaining over time** — 11 panels, no template
variable (SLOs are evaluated in aggregate, not per-service).

This is the dashboard [incident-response.md's MTTR definition](incident-response.md#mttd-and-mttr-exact-definitions)
points to for confirming an SLI actually returned to baseline, not just
that a mitigation command finished running. Its own on-dashboard
description already carries a deliberate caveat, worth repeating here
because it explains numbers that otherwise look alarming: *"the 30-day
figures evaluate over whatever history Prometheus actually has — until
retention reaches 30 days these are 'budget over available data,' not a
true month."* Checked live during this phase, the dashboard currently
shows **93.0% availability and 74.8% latency SLI, both `NOT MET`, with the
availability error budget at −1294%** — and that is not a demo artifact.
Prometheus's data volume genuinely retains this project's real history
back to September 12, so this figure is the honest, cumulative cost of
every deliberately-injected incident in [incidents/](../incidents) and
every real failure found during [Phase 15's load testing](load-testing.md)
landing inside the same rolling window a real 30-day SLO would use.

### A real bug found and fixed while verifying this dashboard

Checking this dashboard live (the same "actually open it in a browser"
practice from Phase 5) turned up something that looked, at first glance,
exactly like a broken pipeline: the **Availability SLO — status** and
**Latency SLO — status** panels rendered a large red block reading
**"MISSING"**. That's indistinguishable at a glance from Grafana's own
grey "No data" state, so the natural first hypothesis was that something
upstream was broken.

It wasn't, and ruling that out took three real steps, in order:

1. **Ruled out a cold-start timing artifact.** The stack had been
   restarted minutes earlier; several `slo:*`/`sli:*` recording rules run
   on a 1-minute evaluation interval, so a dashboard checked within the
   first ~90 seconds of a fresh Prometheus can legitimately show "No data"
   for panels depending on them simply because the rule hasn't produced
   its first sample yet. Generating 150 seconds of sustained real traffic
   and re-checking confirmed this wasn't it — the panels in question still
   showed the same red block well after every recording rule had real,
   fresh values (confirmed directly via `curl` against Prometheus's own
   `/api/v1/query`).
2. **Ruled out missing historical data.** The deeply negative error budget
   looked suspicious enough to independently verify — `docker exec
   pulseops-prometheus-1 ls /prometheus` showed real TSDB blocks dating
   back to September 12, confirming the 93.0%/74.8% figures are computed
   from genuine multi-day history (this project's actual incidents and
   load tests), not corrupted or partial data.
3. **Found the real cause**, by reading the panel's own JSON rather than
   guessing further: both panels evaluate a boolean expression
   (`sli:...:ratio_rate30d >= bool scalar(slo:...:target)`) and use a
   Grafana value mapping to render `0` and `1` as text. The mapping read
   `{"0": "MISSING", "1": "MET"}` — a real, valid query result (`0`,
   meaning "the SLO is currently not met," which is accurate) rendered
   with a label that looks exactly like an error state when it isn't one.

**Fixed** by renaming the `0` mapping from `"MISSING"` to `"NOT MET"` in
both panels (`observability/grafana/dashboards/executive-reliability.json`),
and adding a one-line panel description distinguishing "the SLO evaluated
and is missed" from Grafana's own "No data." Verified live: editing the
file and reloading the dashboard picked up the change within Grafana's
30-second provisioning poll, with no restart needed — direct evidence the
file-based provisioning claimed above actually works as described, not
just in theory.

This is the fourth dashboard in this project to have a real UI bug found
by actually opening it rather than trusting the query result — see Phase
5's Error Rate y-axis bug and Phase 8's two derived-field bugs in
[observability.md](observability.md) for the other three. A query
returning the mathematically correct answer is necessary but not
sufficient for a dashboard to be trustworthy; how that answer is *labeled*
matters just as much, especially on the one dashboard in this project
built for a non-engineer to glance at during an incident.

## Interview Questions This Phase Should Prepare You For

1. **"Why does this project provision dashboards from files instead of
   building them in Grafana's UI?"** — A dashboard built by hand lives
   only in that Grafana instance's own database: not reviewable in a PR,
   not reproducible on a fresh environment, and easy to edit accidentally
   mid-incident. File-based provisioning makes the dashboard itself a
   versioned artifact — demonstrated directly in this phase, where editing
   the JSON and reloading picked up a real fix within 30 seconds, no
   restart required.
2. **"A stat panel shows a big red 'MISSING' where you expected real data.
   What do you check first?"** — Don't assume the pipeline is broken.
   Check, in order: (a) is this a genuinely fresh restart where a
   recording rule hasn't run yet — query the underlying metric directly
   against Prometheus's API, not just through the dashboard; (b) is the
   underlying data actually there — check the TSDB or query a wider time
   range; (c) read the panel's own query and value-mapping configuration —
   a query can be completely correct and still be mislabeled in a way that
   looks like a failure. This dashboard's real bug was step (c), not (a)
   or (b), and skipping straight to "must be broken" would have missed
   that the pipeline was fine and the label was the actual defect.
3. **"Your 30-day SLO dashboard shows a wildly negative error budget right
   after a fresh deploy. Is that a bug?"** — Not necessarily. A `[30d]`
   range-vector query doesn't wait for 30 days of data to exist; it
   computes over whatever history is actually there. Immediately after a
   deploy with a fresh TSDB, a single bad minute can dominate the entire
   available window and produce a number that looks alarming but is
   mathematically honest. The fix is not to hide the number — it's to
   caveat it directly on the dashboard, as this one already does, so a
   viewer isn't left to guess whether it's real.
4. **"Why does the Incident Investigation dashboard put Service Up/Down
   first, above error rate?"** — Every panel below it can look like "no
   errors, all healthy" for a service that has stopped reporting entirely,
   which is the worst kind of false reassurance during an actual outage.
   Checking liveness before any other signal avoids misreading total
   silence as a clean bill of health.
