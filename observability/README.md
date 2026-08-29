# Observability

Config for the three pillars plus alerting:

- `prometheus/` — scrape config + `rules/` for alerting and recording rules
- `grafana/dashboards/` — the four dashboards (executive, service, dependencies, incident investigation)
- `loki/` — log aggregation config
- `tempo/` — trace storage config
- `alertmanager/` — routing, grouping, receivers
- `otel/` — OpenTelemetry Collector config

Populated across Phases 4-12.
