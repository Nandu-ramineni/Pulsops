#!/usr/bin/env bash
# Reverses inject-latency.sh.
#
# Usage:
#   ./restore-latency.sh db
#   ./restore-latency.sh dependency
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:?usage: restore-latency.sh <db|dependency>}"

case "$MODE" in
  db)
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] removing postgres CPU throttle"
    docker update --cpus=0 pulseops-postgres-1
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] postgres unthrottled"
    ;;
  dependency)
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] clearing ARTIFICIAL_LATENCY_MS on order-service"
    unset ARTIFICIAL_LATENCY_MS
    docker compose up -d order-service
    until curl -sf -m 5 http://localhost:4002/health >/dev/null 2>&1; do sleep 2; done
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] order-service restarted without injected latency"
    ;;
  *)
    echo "unknown mode: $MODE (expected db or dependency)" >&2
    exit 1
    ;;
esac
