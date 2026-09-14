// Shared traffic-mix helper for all three load tests. Kept in one place so
// "what does realistic PulseOps traffic look like" has a single definition
// instead of drifting between scripts - the same 60/30/10 read/read/write
// split used for every ad-hoc load generator since Phase 9, now expressed
// as a real, versioned k6 script instead of a bash loop.
import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://gateway:8080';
// Orders/users known to exist from seed data created in setup() - see each
// script's own setup(). Kept small and reused rather than growing the
// dataset unboundedly across every test run.
export const SEED_USER_IDS = [1, 2, 3, 4, 5];

export function ensureSeedUsers() {
  const created = [];
  for (const id of SEED_USER_IDS) {
    const res = http.get(`${BASE_URL}/api/users/${id}`);
    if (res.status === 200) {
      created.push(id);
      continue;
    }
    // Only create if truly absent - a fresh environment vs. one already
    // full of Phase 9/14 data should both work without duplicating users.
    const createRes = http.post(
      `${BASE_URL}/api/users`,
      JSON.stringify({ name: `LoadTest User ${id}`, email: `loadtest-${id}-${Date.now()}@example.com` }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    if (createRes.status === 201) created.push(JSON.parse(createRes.body).id);
  }
  return created;
}

// One "user action" = the 60/30/10 mix: read an order, read a user profile,
// or create a new order. Returns nothing - callers use k6's own metrics.
export function mixedRequest(userIds) {
  const r = Math.random();
  const userId = userIds[Math.floor(Math.random() * userIds.length)];

  if (r < 0.6) {
    // Read an order. IDs accumulate across every phase's testing, so a
    // small random id is virtually guaranteed to exist by now; a 404 here
    // is itself informative (counted, not hidden) rather than excluded.
    const id = Math.floor(Math.random() * 50) + 1;
    const res = http.get(`${BASE_URL}/api/orders/${id}`, { tags: { name: 'GetOrder' } });
    check(res, { 'get order: status is 200 or 404': (r) => r.status === 200 || r.status === 404 });
  } else if (r < 0.9) {
    const res = http.get(`${BASE_URL}/api/users/${userId}`, { tags: { name: 'GetUser' } });
    check(res, { 'get user: status is 200': (r) => r.status === 200 });
  } else {
    const res = http.post(
      `${BASE_URL}/api/orders`,
      JSON.stringify({ userId, item: 'k6-load-test', quantity: 1 }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'CreateOrder' } }
    );
    check(res, { 'create order: status is 202': (r) => r.status === 202 });
  }
}
