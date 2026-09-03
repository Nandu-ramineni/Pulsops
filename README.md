# PulseOps

### SRE Observability & Incident Response Platform

> A production-style SRE platform that detects service failures, correlates metrics,
> logs and traces, evaluates SLOs, triggers actionable alerts, and supports structured
> incident investigation and recovery.

This is a companion project to **KubeForge** (AWS/Terraform/EKS/GitOps/Argo CD). Where
KubeForge proves infrastructure-as-code and platform engineering, PulseOps proves the
**operations** half of SRE: can you tell a distributed system is unhealthy, prove it
with data, find the root cause, and recover it — with real, measured numbers, not
invented ones.

## Status

Build is incremental, phase by phase. See [docs/architecture.md](docs/architecture.md)
for the full design rationale.

| Phase | Area | Status |
|---|---|---|
| 1 | Architecture & SRE Design | ✅ done |
| 2 | Application Foundation | ✅ done |
| 3 | Docker Compose Environment | ✅ done |
| 4 | Metrics Instrumentation | ✅ done |
| 5 | Prometheus & Grafana | ✅ done |
| 6 | Structured Logging & Loki | ✅ done |
| 7 | OpenTelemetry & Tempo | ✅ done |
| 8 | Correlating Metrics/Logs/Traces | ⬜ not started |
| 9 | SLI/SLO Design | ⬜ not started |
| 10 | Error Budgets & Burn Rates | ⬜ not started |
| 11 | Prometheus Alert Rules | ⬜ not started |
| 12 | Alertmanager | ⬜ not started |
| 13 | Incident Response Framework | ⬜ not started |
| 14 | Failure Simulation | ⬜ not started |
| 15 | Load & Stress Testing | ⬜ not started |
| 16 | Incident Docs & Postmortems | ⬜ not started |
| 17 | Final Dashboards & Docs | ⬜ not started |

## Architecture (summary)

```mermaid
flowchart TD
    U[Client / k6] --> GW[API Gateway]
    GW --> US[User Service]
    GW --> OS[Order Service]
    US --> PG[(PostgreSQL)]
    OS --> PG
    OS --> RD[(Redis Cache)]
    OS --> MQ[[RabbitMQ]]
    MQ --> WK[Worker Service]
    WK --> PG
```

Full rationale, request-path tracing walkthrough, and technology decisions are in
[docs/architecture.md](docs/architecture.md).

## Repository Structure

```text
pulseops/
├── services/           gateway, user-service, order-service, worker
├── observability/       prometheus, grafana, loki, alloy, tempo, alertmanager config
├── incidents/           reproducible failure scenarios + investigation writeups
├── load-tests/          k6 scripts
├── scripts/              failure-injection scripts (kill-service, break-redis, ...)
├── docs/                 architecture, SLOs, alerting, runbooks, postmortems
└── docker-compose.yml
```

## Quick Start

```bash
cp .env.example .env
docker compose up -d --build
```

This starts Postgres, Redis, RabbitMQ, and all four services. The gateway
listens on **http://localhost:7000** (not 8080 — see note below).

```bash
# create a user
curl -X POST http://localhost:7000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Nandu","email":"nandu@example.com"}'

# create an order for that user
curl -X POST http://localhost:7000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"item":"widget","quantity":3}'

# check it - status should flip from "pending" to "completed"
# within a second or two once the worker consumes it off RabbitMQ
curl http://localhost:7000/api/orders/1
```

Other useful endpoints while it's running:
- **Grafana: http://localhost:3000** (admin/admin, or browse anonymously) —
  two dashboards auto-provisioned: **Service Overview** and
  **Dependencies**. See [docs/observability.md](docs/observability.md) for
  what each panel means, the RED method, and why two dashboards from the
  original spec are deliberately deferred to later phases.
- Prometheus: http://localhost:9200 — raw metrics/query UI and scrape
  target health (`/targets`).
- Loki: http://localhost:3100 — query logs from Grafana's **Explore** tab
  (pick the Loki datasource). Every service logs structured JSON carrying a
  `requestId`, so one query follows a single request across all four
  services *and* across the RabbitMQ hop:
  ```logql
  {job="pulseops"} | requestId=`<paste-an-id>`
  ```
  Any response from the gateway returns its ID in the `x-request-id`
  header, so `curl -i` gives you something to paste.
- Tempo: http://localhost:3200 — distributed traces. Query them from
  Grafana's **Explore** tab with the Tempo datasource. Every log line
  emitted inside a request carries a `traceId`, so you can copy one
  straight out of a log into Explore and get the full span waterfall:
  one `POST /api/orders` is **49 spans across all four services**,
  including the hop across RabbitMQ into the worker.
- Grafana Alloy: http://localhost:12345 — the single telemetry agent's own
  UI. It ships container logs to Loki *and* receives OTLP traces from the
  services and forwards them to Tempo, so this is the first place to look
  if either logs or traces stop arriving.
- RabbitMQ management UI: http://localhost:15672 (guest/guest) — watch the
  `order.created` queue depth live.
- Prometheus-format `/metrics` on every service: gateway `:7000`,
  user-service `:4001`, order-service `:4002`, worker `:4003`, plus
  RabbitMQ's own broker metrics on `:15692`.
- `docker compose logs -f worker` — watch orders get consumed.
- `docker compose down -v` — stop everything and wipe all volumes
  (Postgres data, Prometheus history, Grafana state).

**Why port 7000 (and Prometheus on 9200, not 9090):** on this dev machine,
Hyper-V/WSL reserves large chunks of the 7975-9191 range as dynamic port
exclusions, so Docker can't bind 8080, 8081, 9090, or 9091 to the host.
Same root cause both times, same fix — remap the host side only. The
containers still listen on their standard ports internally (gateway 8080,
Prometheus 9090) — only the host-side mapping changed
(`"7000:8080"` and `"9200:9090"` in `docker-compose.yml`). If your machine
doesn't have this issue, feel free to remap them back to the defaults.

**A real reliability bug found and fixed during this phase:** RabbitMQ's
Docker healthcheck (`rabbitmq-diagnostics ping`) reports "healthy" before the
AMQP listener on port 5672 is actually ready to accept connections — a real
race observed while testing, not a hypothetical one. The worker's first
connection attempt on a fresh `docker compose up` hit `ECONNREFUSED`. Fixed
with bounded exponential backoff on startup (`services/worker/src/index.js`)
instead of crashing on the first failure — see the worker logs on a fresh
`docker compose up -d --build` for it retrying in real time.
