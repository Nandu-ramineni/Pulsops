// Normal load: does the system meet its own SLOs (docs/slos.md) under the
// traffic level it was actually measured against in Phase 9?
//
// The thresholds below are not arbitrary k6 defaults - they are this
// project's real SLO targets, so a passing k6 run IS an SLO compliance
// check, not just a generic load test:
//   p95 < 250ms   -- the latency SLO threshold (docs/slos.md)
//   error rate < 0.5%  -- the complement of the 99.5% availability SLO
//
// Run:
//   docker run --rm --network pulseops_default \
//     -v "$(pwd)/load-tests:/scripts:ro" -e BASE_URL=http://gateway:8080 \
//     grafana/k6:0.54.0 run /scripts/normal-load.js
import { sleep } from 'k6';
import { ensureSeedUsers, mixedRequest } from './common.js';

export const options = {
  scenarios: {
    normal_traffic: {
      executor: 'constant-arrival-rate',
      rate: 15,               // 15 req/s - the sustained rate this project's SLOs were measured against
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<250'],   // latency SLO
    http_req_failed: ['rate<0.005'],    // availability SLO (99.5%)
  },
};

export function setup() {
  return { userIds: ensureSeedUsers() };
}

export default function (data) {
  mixedRequest(data.userIds);
  sleep(0.05);
}
