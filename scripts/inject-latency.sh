#!/usr/bin/env bash
# Injects real, measurable latency for Incidents 1 and 5. Two modes because
# "database slowdown" and "dependency latency" are genuinely different
# failure shapes worth telling apart:
#
#   db <cpus>          CPU-throttles the Postgres container (docker update
#                       --cpus). Under concurrent load this produces real
#                       queuing delay inside Postgres itself - not a fake
#                       sleep - so db_query_duration_seconds and connection
#                       pool wait time move for real. Reversed by
#                       restore-latency.sh db.
#
#   dependency <ms>     Sets ARTIFICIAL_LATENCY_MS on order-service and
#                       restarts it. The delay lives in
#                       services/order-service/src/index.js as a feature
#                       flag that is a no-op unless this env var is set -
#                       the same pattern the worker already uses for
#                       simulateProcessing(), applied deliberately for
#                       controlled fault injection instead of hard-coded
#                       into every request.
#
# Usage:
#   ./inject-latency.sh db 0.1
#   ./inject-latency.sh dependency 700
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:?usage: inject-latency.sh <db|dependency> <value>}"
VALUE="${2:?usage: inject-latency.sh <db|dependency> <value>}"

case "$MODE" in
  db)
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] throttling postgres to --cpus=$VALUE"
    docker update --cpus="$VALUE" pulseops-postgres-1
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] postgres throttled"
    ;;
  dependency)
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] setting ARTIFICIAL_LATENCY_MS=$VALUE on order-service"
    ARTIFICIAL_LATENCY_MS="$VALUE" docker compose up -d order-service
    until curl -sf -m 5 http://localhost:4002/health >/dev/null 2>&1; do sleep 2; done
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] order-service restarted with injected latency"
    ;;
  *)
    echo "unknown mode: $MODE (expected db or dependency)" >&2
    exit 1
    ;;
esac
