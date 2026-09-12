#!/usr/bin/env bash
# Stops one service container to simulate it being down, crashed, or
# unreachable. Pairs with restore-service.sh.
#
# Usage: ./kill-service.sh <service-name>
#   e.g. ./kill-service.sh user-service
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE="${1:?usage: kill-service.sh <service-name>}"

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] stopping $SERVICE"
docker compose stop "$SERVICE"
echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] $SERVICE stopped"
