# Services

Four Node.js/Express services — see [../docs/architecture.md](../docs/architecture.md) for why this topology.

- `gateway/` — single entry point, routes to user-service and order-service
- `user-service/` — CRUD over PostgreSQL
- `order-service/` — Postgres + Redis + RabbitMQ producer
- `worker/` — RabbitMQ consumer, writes Postgres

Built in Phase 2 (Application Foundation).

- `alert-receiver/` — a real webhook target for Alertmanager, standing in
  for Slack/PagerDuty/email since this project has no credentials for
  those. Built in Phase 12 — see [../docs/alerting.md](../docs/alerting.md)
  for why this exists instead of a faked delivery log.
