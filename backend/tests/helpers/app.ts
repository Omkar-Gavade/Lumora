import type { Server } from 'node:http';
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
 * Built once rather than per test because it is stateless — the state that does
 * need resetting (database, rate limits, outbox, vectors) is handled by
 * `setup-integration.ts`.
 */
const app = createApp();

/**
 * One listening server, shared by every request in the file.
 *
 * **This is a fix, not an optimisation.** Handing `supertest` the app object
 * makes it `listen(0)` and close a fresh ephemeral port *per request*; a full
 * suite run does that several hundred times, and on macOS a small fraction of
 * those bind/close cycles fail transiently. The symptoms were a request
 * answering `400` with an empty body, or a status that no route could have
 * produced — surfacing as roughly one flaky test per ten full runs, always in a
 * different file, and never reproducible in isolation.
 *
 * Binding once removes the churn entirely. `listen(0)` still picks a free port,
 * so nothing collides with a developer's dev server, and `closeTestServer`
 * releases it in the same `afterAll` that closes the database pool.
 */
let server: Server | null = null;

function listening(): Server {
  server ??= app.listen(0);
  return server;
}

/** A fresh, cookie-less request. Use for anonymous endpoints. */
export function request(): TestAgent {
  return supertest(listening());
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
  return supertest.agent(listening());
}

/**
 * The origin of the shared test server.
 *
 * Needed by the streaming tests, which drive real `fetch` rather than
 * supertest: supertest buffers the whole response before resolving, which
 * makes it structurally unable to observe a stream as it arrives.
 */
export function baseUrl(): string {
  const address = listening().address();

  if (address === null || typeof address === 'string') {
    throw new Error('the test server is not listening on a TCP port');
  }

  return `http://127.0.0.1:${String(address.port)}`;
}

/** Releases the port so Vitest can exit. Called once, alongside the pool close. */
export async function closeTestServer(): Promise<void> {
  if (server === null) return;

  const instance = server;
  server = null;

  await new Promise<void>((resolve) => {
    instance.close(() => resolve());
  });
}

export { app };
