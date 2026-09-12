#!/usr/bin/env bash
# Restarts a service stopped by kill-service.sh and waits for it to become
# reachable again.
#
# Usage:
#   ./restore-service.sh <service-name> <health-command>
#   e.g. ./restore-service.sh user-service "curl -sf http://localhost:4001/health"
#   e.g. ./restore-service.sh redis "docker exec pulseops-redis-1 redis-cli ping"
#
# Takes a full command rather than assuming an HTTP URL - found while
# running Incident 2, where the original version only accepted a URL and
# hung forever curling Redis's raw TCP port with an HTTP GET.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE="${1:?usage: restore-service.sh <service-name> <health-command>}"
HEALTH_CMD="${2:?usage: restore-service.sh <service-name> <health-command>}"

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] starting $SERVICE"
docker compose start "$SERVICE"

until eval "$HEALTH_CMD" >/dev/null 2>&1; do sleep 2; done
echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] $SERVICE healthy again"
