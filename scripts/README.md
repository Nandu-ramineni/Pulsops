# Failure Injection Scripts

Reproducible scripts backing the incidents in `../incidents/`. Every script
prints UTC timestamps on injection/restoration so an incident's MTTD/MTTR
can be computed precisely against Alertmanager's real delivery log
(`http://localhost:4004/alerts`), per the definitions in
[docs/incident-response.md](../docs/incident-response.md).

| Script | Used by | What it does |
|---|---|---|
| `kill-service.sh <service>` | general | Stops one service container |
| `restore-service.sh <service> <health-command>` | general | Starts it back up and waits for a passed-in health check to succeed — takes a full command, not just a URL, since not every service speaks HTTP (Redis doesn't) |
| `break-redis.sh` | [Incident 002](../incidents/incident-002-redis-failure) | Stops Redis |
| `create-queue-backlog.sh` | [Incident 004](../incidents/incident-004-queue-backlog) | Stops the worker while publishing continues |
| `inject-latency.sh db <cpus>` | [Incident 001](../incidents/incident-001-database-slowdown) | CPU-throttles Postgres (`docker update --cpus`) — real queuing delay, not a fake sleep |
| `inject-latency.sh dependency <ms>` | [Incident 005](../incidents/incident-005-high-latency) | Sets `ARTIFICIAL_LATENCY_MS` on order-service and restarts it |
| `restore-latency.sh db\|dependency` | Incidents 001, 005 | Reverses either latency injection |

Incident 003 (bad deployment) has no script — it's a real `git commit` /
`git revert` pair (`12f6777` / `eabfd87`), deployed with
`docker compose up -d --build --no-deps order-service`. The `--no-deps` is
load-bearing: without it, `docker compose up` re-evaluates every
`depends_on` condition and can silently restart an intentionally-stopped
dependency, which is exactly what happened by accident the first time
Incident 002 was run.
