import { describe, expect, it } from 'vitest';
import { GLOBAL_RATE_LIMIT } from '../../src/config/constants.js';
import { API_PREFIX, request } from '../helpers/app.js';

/**
 * The global ceiling from docs/04-data-and-api.md §3.4 — 300 / 15 min per IP.
 *
 * It was specified in M2 and left unmounted until M7, with a comment in
 * `app.ts` saying it would land "when there are non-auth routes for it to
 * protect". Those routes arrived over M3–M6b and the ceiling did not, which is
 * the ordinary way a documented control quietly never ships.
 *
 * These tests assert *mounting and scope*, not enforcement: driving 301 real
 * requests through supertest to watch a counter tick would spend seconds
 * proving what `rate-limit.store.test.ts` already proves about the counter, and
 * the interesting failure here is "nobody wired it up", not "the algorithm is
 * wrong".
 */
describe('global rate limit', () => {
  it('applies to an ordinary API route', async () => {
    /*
      Deliberately unauthenticated. The limiter sits ahead of the routes, so it
      must count a request that never reaches a handler — that is precisely the
      traffic a global ceiling exists to bound.
    */
    const response = await request().get(`${API_PREFIX}/documents`).expect(401);

    expect(response.headers['ratelimit-limit']).toBe(String(GLOBAL_RATE_LIMIT));
  });

  it('applies to unmatched paths', async () => {
    // A 404 is free to generate and unbounded in variety, which makes it the
    // cheapest surface to enumerate against. It must be counted.
    const response = await request().get(`${API_PREFIX}/no-such-route`).expect(404);

    expect(response.headers['ratelimit-limit']).toBe(String(GLOBAL_RATE_LIMIT));
  });

  it('exempts health checks', async () => {
    /*
      A load balancer polling once a second spends the whole per-IP budget in
      five minutes. The victim would not be the probe — it is every real user
      behind that egress address, refused by a limit they never went near.
    */
    const response = await request().get('/health').expect(200);

    expect(response.headers['ratelimit-limit']).toBeUndefined();
  });

  it('lets a stricter per-route limit own the advertised budget', async () => {
    /*
      Both limiters run on `/auth/signup`, and each writes `RateLimit-*`. The
      route limiter runs second and wins, which is the right way round: 3/hour
      is the limit this client will actually hit, so it is the one worth
      telling them about. Reversed, a client would see 300 remaining while
      being refused after 3.
    */
    const response = await request()
      .post(`${API_PREFIX}/auth/signup`)
      .send({ email: 'not-an-email', password: 'x', displayName: '' });

    expect(response.headers['ratelimit-limit']).toBe('3');
  });
});
