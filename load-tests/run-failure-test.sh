#!/usr/bin/env bash
# Orchestrates failure-test.js: starts k6 generating sustained load, injects
# a real failure from Phase 14's scripts partway through, restores it, and
# lets k6 keep measuring until the run completes. One combined k6 summary
# then shows the full healthy -> degraded -> recovered shape under
# continuous load, not just point-in-time curls.
#
# Usage: ./run-failure-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

K6_LOG="/tmp/pulseops-failure-test-k6.log"

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] starting k6 (6m sustained load)"
# MSYS_NO_PATHCONV=1 is load-bearing on Git Bash / Windows: without it,
# "/scripts/failure-test.js" gets silently rewritten to a Windows path and
# k6 exits immediately with "moduleSpecifier ... couldn't be found" - which
# happened for real the first time this script ran, producing a redis
# outage with zero k6 load behind it. Confirmed the fix by requiring the k6
# banner to actually appear before proceeding past the baseline sleep.
MSYS_NO_PATHCONV=1 docker run --rm --network pulseops_default \
  -v "$(pwd)/load-tests:/scripts:ro" \
  -e BASE_URL=http://gateway:8080 \
  grafana/k6:0.54.0 run /scripts/failure-test.js > "$K6_LOG" 2>&1 &
K6_PID=$!

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] waiting for k6 to actually start..."
for i in $(seq 1 20); do
  grep -q "scenarios:" "$K6_LOG" 2>/dev/null && break
  if ! kill -0 "$K6_PID" 2>/dev/null; then
    echo "k6 exited early - aborting before touching redis. Log:"
    cat "$K6_LOG"
    exit 1
  fi
  sleep 1
done
grep -q "scenarios:" "$K6_LOG" 2>/dev/null || { echo "k6 never started within 20s - aborting. Log:"; cat "$K6_LOG"; exit 1; }
echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] k6 confirmed running"

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] baseline window (90s of healthy load)"
sleep 90

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] injecting failure: stopping redis"
./scripts/break-redis.sh

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] failure window (2m under load)"
sleep 120

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] restoring redis"
./scripts/restore-service.sh redis "docker exec pulseops-redis-1 redis-cli ping"

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] recovery window - waiting for k6 to finish"
wait "$K6_PID"

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] k6 run complete, summary:"
cat "$K6_LOG"
