# Load Tests

k6 scripts used to generate real traffic against the live stack and measure
real numbers — never invented (see project rules). Built in Phase 15; see
[docs/load-testing.md](../docs/load-testing.md) for the full results,
root-cause investigations, and the two fixes/findings this phase produced.

All three run via the official `grafana/k6` Docker image, joined directly to
the compose network so they hit the gateway the same way a real client would
(`http://gateway:8080`), without touching a host port:

```bash
docker run --rm --network pulseops_default \
  -v "$(pwd)/load-tests:/scripts:ro" -e BASE_URL=http://gateway:8080 \
  grafana/k6:0.54.0 run /scripts/<script>.js
```

- **`common.js`** — shared 60/30/10 read-order/read-user/create-order
  traffic mix and seed-user setup, used by all three scripts below.
- **`normal-load.js`** — 15 req/s for 3 minutes, with k6 thresholds set to
  this project's actual SLO values (`docs/slos.md`). A passing run is a
  direct SLO compliance check.
- **`stress-test.js`** — ramps 15 → 800 req/s in stages, no gating
  thresholds, to find where the system actually breaks.
- **`failure-test.js`** — 6 minutes of sustained load with a real failure
  (Redis stopped, then restored) injected partway through. Not run
  directly — use `run-failure-test.sh` below, which orchestrates it.

```bash
./run-failure-test.sh
```

orchestrates `failure-test.js`: starts k6 in the background, waits for its
own startup banner to confirm it's actually generating load (a real bug in
an earlier version of this script skipped that check and produced a Redis
outage with zero load behind it — see `docs/load-testing.md`), then injects
and restores the failure partway through the run.
