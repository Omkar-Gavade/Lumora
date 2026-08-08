import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { fakeMailProvider } from '../fixtures/fake-mail.provider.js';

/*
  The mail provider is replaced for every integration test.

  `vi.mock` is hoisted above the imports below, which is what lets it intercept
  `mail.factory.js` before `verification.service.js` resolves its
  `mailProvider` binding. Mocking the factory rather than the transport means
  the services under test are entirely unmodified — they import the same
  symbol from the same path and never learn they are in a test.
*/
vi.mock('../../src/providers/mail/mail.factory.js', async () => {
  const { fakeMailProvider: fake } = await import('../fixtures/fake-mail.provider.js');
  return { mailProvider: fake, createMailProvider: () => fake };
});

const { resetDatabase, closeTestDatabase } = await import('../helpers/database.js');
const { resetRateLimitsForTests } = await import('../../src/api/middleware/rate-limit.js');
const { resetVectorStoreForTests } = await import('../helpers/vector.js');
const { closeTestServer } = await import('../helpers/app.js');

/**
 * Per-test isolation for HTTP flows.
 *
 * Three pieces of shared state have to be reset, and missing any one produces
 * a test that fails only when run after some other test:
 *
 *   database    — truncated, because a supertest request runs through the real
 *                 pool and cannot join a transaction the test opened. See
 *                 `helpers/database.ts` for why that is not the documented
 *                 rollback strategy.
 *   rate limits — in-memory and keyed by IP; every test is 127.0.0.1.
 *   outbox      — the fake provider accumulates across tests.
 *
 * `beforeEach` rather than `afterEach` so a failed test leaves its rows in the
 * database for inspection, and the next test still starts clean.
 */
beforeEach(async () => {
  await resetDatabase();
  resetRateLimitsForTests();
  fakeMailProvider.clear();
  // The vector store is a module-level singleton holding a Map — without this,
  // a document indexed in one test is still indexed in the next.
  resetVectorStoreForTests();
});

afterEach(() => {
  // Anything a test stubbed on the fake — a forced failure, an unhealthy
  // transport — must not leak into the next one.
  fakeMailProvider.clear();
});

afterAll(async () => {
  // Vitest will not exit while the pool or the test server holds open sockets.
  await closeTestServer();
  await closeTestDatabase();
});
