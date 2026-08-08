import { loadTestEnv } from './test-env.js';

/**
 * Vitest `setupFiles` entry.
 *
 * Deliberately the smallest possible module: it runs before every test file's
 * imports, and anything else in here risks pulling `src/config` into the graph
 * ahead of the mapping — which would freeze the unmapped environment for the
 * whole worker.
 */
loadTestEnv();
