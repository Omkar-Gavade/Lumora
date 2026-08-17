import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, split by environment.
 *
 * `unit` stays on `node`: it tests pure logic that guards navigation, and
 * standing up a DOM to exercise a string function costs a second of startup for
 * nothing. `component` gets `jsdom`, because M7's Settings work is the first
 * surface where the behaviour worth testing *is* the interaction — a
 * destructive confirmation that must resist a stray Enter key cannot be
 * verified by calling a function.
 */
export default defineConfig({
  /*
    `src/app/config/env.ts` validates `VITE_API_URL` at module load and throws
    when it is absent — deliberately, so a misconfigured deployment fails
    loudly rather than serving an app that cannot reach its API. Every test
    that touches the API client imports it transitively.

    A developer has `frontend/.env`; CI does not, so the whole suite died on a
    configuration error rather than on anything it was testing. Defined here so
    `npm test` is self-sufficient wherever it runs.
  */
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify(
      process.env.VITE_API_URL ?? 'http://localhost:4000',
    ),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    projects: [
      {
        resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
        test: {
          name: 'frontend-unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
        test: {
          name: 'frontend-component',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./tests/setup/component.ts'],
          include: ['tests/component/**/*.test.tsx'],
        },
      },
    ],
  },
});
