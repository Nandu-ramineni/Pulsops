# Services

Four Node.js/Express services — see [../docs/architecture.md](../docs/architecture.md) for why this topology.

- `gateway/` — single entry point, routes to user-service and order-service
- `user-service/` — CRUD over PostgreSQL
- `order-service/` — Postgres + Redis + RabbitMQ producer
- `worker/` — RabbitMQ consumer, writes Postgres

Built in Phase 2 (Application Foundation).
