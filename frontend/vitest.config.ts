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
