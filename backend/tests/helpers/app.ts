import supertest from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../src/app.js';

/**
 * The API prefix, mirrored from `src/api/routes/index.ts`.
 *
 * Imported rather than retyped so a version bump moves every test at once —
 * a suite with the old prefix hard-coded in forty files is a suite nobody
 * upgrades.
 */
export { API_PREFIX } from '../../src/api/routes/index.js';

/**
 * The Express app, built once per test file.
 *
 * `createApp()` deliberately does not listen (docs/03-backend.md §2), so
 * supertest binds an ephemeral port per request and there is no server
 * lifecycle to manage, no port to collide on, and no teardown to forget.
 *
 * Built once rather than per test because it is stateless — the state that
 * does need resetting (database, rate limits, outbox) is handled by
 * `setup-integration.ts`.
 */
const app = createApp();

/** A fresh, cookie-less request. Use for anonymous endpoints. */
export function request(): TestAgent {
  return supertest(app);
}

/**
 * A persistent agent that stores cookies across requests, the way a browser
 * does.
 *
 * Required for anything involving refresh: rotation replaces the cookie on
 * every call, and a test that keeps sending the original is testing replay
 * detection whether it meant to or not.
 */
export function agent(): TestAgent {
  return supertest.agent(app);
}

export { app };
