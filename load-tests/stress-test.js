// Stress test: ramp well past normal load in stages to find where this
// system actually breaks, rather than assuming it. No pass/fail thresholds
// gate the run early - the point is to observe and measure the breaking
// point, not to enforce one.
//
// A specific, real, predictable candidate for that breaking point: neither
// order-service nor user-service sets a `max` on its pg.Pool
// (services/*/src/db.js), so each defaults to 10 connections. Watch
// db_pool_connections{state="waiting"} in Prometheus during this run -
// non-zero there is the pool queueing requests, which should show up as
// rising latency before it shows up as errors.
//
// Run:
//   docker run --rm --network pulseops_default \
//     -v "$(pwd)/load-tests:/scripts:ro" -e BASE_URL=http://gateway:8080 \
//     grafana/k6:0.54.0 run /scripts/stress-test.js
import { ensureSeedUsers, mixedRequest } from './common.js';

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: 15,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 400,
      stages: [
        { target: 15, duration: '30s' },   // confirm normal baseline first
        { target: 50, duration: '45s' },
        { target: 150, duration: '45s' },
        { target: 400, duration: '45s' },
        { target: 800, duration: '45s' },  // expected to be well past the breaking point
        { target: 0, duration: '30s' },    // ramp down - confirms recovery, not just failure
      ],
    },
  },
  // Reporting thresholds only (no abortOnFail) - these don't stop the test,
  // they just make the pass/fail visible in the summary against the same
  // SLO used in normal-load.js, for an at-a-glance "how far past the SLO
  // did we push it" comparison.
  thresholds: {
    http_req_duration: [{ threshold: 'p(95)<250', abortOnFail: false }],
    http_req_failed: [{ threshold: 'rate<0.005', abortOnFail: false }],
  },
};

export function setup() {
  return { userIds: ensureSeedUsers() };
}

export default function (data) {
  mixedRequest(data.userIds);
}
