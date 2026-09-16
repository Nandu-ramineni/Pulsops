# Postmortems

Blameless postmortems for each major simulated incident, using only measured numbers (real MTTD/MTTR from Phase 14 runs, never invented). Written in Phase 16.

| Postmortem | SEV | MTTD | Headline finding |
|---|---|---|---|
| [Database Slowdown](2026-09-12-database-slowdown.md) | SEV-2 | 4m31.9s | Gateway p95 rose ~45x under Postgres CPU throttle; zero errors, zero pool saturation — latency is the only signal |
| [Redis Failure](2026-09-12-redis-failure.md) | SEV-4 (was SEV-1 pre-fix) | 6m30.2s (post-fix) | The cache-aside fallback's GET path rethrew instead of degrading, and an unbounded reconnect strategy meant a request could hang forever — found and fixed mid-incident |
| [Bad Deployment](2026-09-12-bad-deployment.md) | SEV-1 | 4m30.8s | A one-character typo caused silent server-side success behind a client-visible 500 — proven by finding the "failed" order in Postgres |
| [Queue Backlog](2026-09-12-queue-backlog.md) | SEV-3 | 2m31.2s (ServiceDown); never (QueueBacklogGrowing, as shipped) | The alert built to catch a dead consumer was structurally incapable of firing while the consumer was dead — an absent-vs-zero PromQL bug |
| [High Latency](2026-09-12-high-latency.md) | SEV-2 | 4m35.8s | The control case: an application-layer fault injection behaving exactly as designed, in contrast to the other four |

Use [TEMPLATE.md](TEMPLATE.md) — copy it to `YYYY-MM-DD-<slug>.md` per
incident. See [docs/incident-response.md](../incident-response.md) for the
severity levels, the full lifecycle, and the exact MTTD/MTTR definitions
the template's timeline section expects. Each postmortem here corresponds
to one incident under [incidents/](../../incidents) — the incident README
holds the full technical investigation (metrics/logs/traces/PromQL used);
the postmortem here is the structured, blameless writeup built from that
same real data.
