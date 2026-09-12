#!/usr/bin/env bash
# Simulates a Redis outage for Incident 2. Thin wrapper over kill-service.sh
# named separately because Redis failing is a specific, well-known failure
# mode this system is designed to tolerate (cache-aside): order-service
# should keep working by falling through to user-service on every request,
# just slower and with more load on Postgres.
set -euo pipefail
cd "$(dirname "$0")"
./kill-service.sh redis
