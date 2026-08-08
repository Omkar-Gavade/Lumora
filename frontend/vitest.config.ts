import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The frontend's unit project.
 *
 * Deliberately minimal, and deliberately `node` rather than `jsdom`: what is
 * tested here is pure logic that guards navigation, and standing up a DOM to
 * exercise a string function would add a dependency and a second of startup
 * for nothing. Component tests, when they arrive, get their own environment.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    name: 'frontend-unit',
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
