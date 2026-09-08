# Runbook: Service down

**Alert:** `ServiceDown` — Prometheus could not scrape a service for 2+ minutes.

## What this means

The process is stopped, crash-looping, or unreachable. Note this fires on
**scrape failure**, which is a slightly different thing from "users are
affected": a service can be unscrapeable while still serving, and can be
serving nothing while scraping fine.

Also note the deliberate gap it covers: if traffic has stopped too, the
burn-rate alerts stay *silent*, because a ratio with a zero denominator has
no value. `ServiceDown` is what catches a 3am outage that nobody is
generating traffic against.

## Impact by service

| Service down | What breaks |
|---|---|
| `gateway` | **Everything.** Single entry point, no redundancy. |
| `user-service` | User reads 502. Order creation fails on cache **miss** only — a warm cache masks this, so impact ramps up as the cache expires. |
| `order-service` | All order reads and writes fail. |
| `worker` | No user-visible failure. Orders are accepted and stay `pending` forever — a silent correctness problem, not an outage. |

The `worker` row is the one to be careful with: nothing user-facing breaks,
so no burn-rate alert fires, and the damage is invisible until someone asks
why orders never completed.

## Severity

- `gateway` or `order-service` → SEV-1
- `user-service` → SEV-2
- `worker` → SEV-3 (no immediate user impact, but data is silently incorrect)

## First checks

```bash
docker compose ps
```

```bash
docker compose logs --tail 100 <service>
```

Look for: a crash loop (`Restarting`), `missing required environment
variables` (config), or `ECONNREFUSED` (a dependency it needs is itself
down).

Check whether its dependencies are actually up — `postgres` and `redis` both
have healthchecks, and a service failing to start often means what it
depends on is missing rather than the service being broken.

## Mitigation

```bash
docker compose up -d <service>
```

If it crash-loops immediately, read the first 20 lines of its log — the
services fail fast and loudly on missing configuration by design, so the
reason is usually in the first thing they print.

## Verify recovery

```bash
curl -s http://localhost:8080/health
```

```promql
up{job=~"gateway|user-service|order-service|worker"}
```

All should read `1`. Then confirm the burn-rate alerts clear — they lag by
the length of their short window.

## Prevention

Every service already has `restart: unless-stopped`, and so do `postgres`
and `redis` (they did not until this was caught: the stack came back
half-alive after a Docker restart, with the app tier running and the
datastores absent).

The deeper issue is that nothing here is redundant — one instance of
everything. That is a known, accepted constraint recorded in
`docs/slos.md`, and it is the main reason the availability SLO is set at
99.5% rather than 99.9%.
