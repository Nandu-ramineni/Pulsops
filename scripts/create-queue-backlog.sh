#!/usr/bin/env bash
# Simulates Incident 4: the worker stops draining the queue while orders
# keep arriving. Stopping the worker outright (rather than just slowing it)
# gives a clean, unambiguous backlog - publish rate stays constant, consume
# rate drops to exactly zero, so QueueBacklogGrowing's derived proxy
# (publish rate - consume rate) is unambiguous.
set -euo pipefail
cd "$(dirname "$0")"
./kill-service.sh worker
