import { z } from 'zod';

/**
 * Zod-validated `import.meta.env` (docs/02-frontend.md §2).
 *
 * The mirror of the backend's `config/env.ts`, and for the same reason: a
 * missing `VITE_API_URL` would otherwise become the string `"undefined"` in
 * every request URL, and the first symptom is a 404 nobody can explain.
 *
 * Vite inlines `import.meta.env` at build time, so this validates at build and
 * again on first import in the browser — a misconfigured deploy fails loudly
 * on load rather than on the first fetch.
 */
const envSchema = z.object({
  /** Absolute origin of the API, no trailing slash. */
  VITE_API_URL: z.url().transform((value) => value.replace(/\/+$/, '')),
});

const parsed = envSchema.safeParse(import.meta.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  // Thrown, not logged. A silently degraded app that cannot reach its API is
  // worse than one that refuses to start with a readable reason.
  throw new Error(`Invalid frontend environment configuration:\n${detail}`);
}

export const env = parsed.data;
