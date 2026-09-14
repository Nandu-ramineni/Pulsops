// Failure-condition load test: sustained, moderate load for long enough
// that an external script (run-failure-test.sh) can inject a real failure
// partway through and restore it before the end - the same failure
// injection built in Phase 14, now exercised under continuous measured
// load instead of a handful of manual curls.
//
// This script alone just generates steady traffic. It does not know a
// failure is coming - which is the point: the load profile is identical to
// what a real user-facing load pattern looks like, and whatever happens to
// the metrics happens because of the injected failure, not because the
// test script changed behavior.
//
// Not run directly - see run-failure-test.sh, which orchestrates this
// alongside a Phase 14 failure script.
import { sleep } from 'k6';
import { ensureSeedUsers, mixedRequest } from './common.js';

export const options = {
  scenarios: {
    sustained_load: {
      executor: 'constant-arrival-rate',
      rate: 15,
      timeUnit: '1s',
      duration: '6m',
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  // No thresholds gate this run - it is EXPECTED to violate the normal SLO
  // thresholds during the injected failure window. The point is to measure
  // the shape of that violation and the recovery afterward, not to pass or
  // fail a single number.
};

export function setup() {
  return { userIds: ensureSeedUsers() };
}

export default function (data) {
  mixedRequest(data.userIds);
  sleep(0.05);
}
