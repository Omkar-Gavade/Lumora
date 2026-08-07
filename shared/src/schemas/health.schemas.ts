import { z } from 'zod';

/**
 * The `/health` and `/health/ready` contracts.
 *
 * These are Zod schemas rather than plain types because both sides use them at
 * runtime: the backend asserts its own response against them in contract tests
 * (docs/03-backend.md §9), and the frontend parses the payload it receives. A
 * field renamed on one side then fails a test rather than failing silently in
 * a browser.
 */

/** Liveness. Answers "is this process running", and touches nothing else. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  /** Whole seconds since the process started. */
  uptime: z.number().int().nonnegative(),
  version: z.string().min(1),
  environment: z.enum(['development', 'test', 'production']),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * One dependency's verdict. `latencyMs` is present on both outcomes — how long
 * a failing check took to fail is the difference between "refused instantly"
 * and "timed out", which is the first thing anyone debugging wants to know.
 */
export const dependencyCheckSchema = z.object({
  status: z.enum(['ok', 'error']),
  latencyMs: z.number().int().nonnegative(),
  /** Present only when `status` is `error`. Safe, generic text. */
  message: z.string().optional(),
});

export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

/**
 * Readiness. Answers "can this process serve traffic", which is a different
 * question from liveness and deserves a different endpoint: an orchestrator
 * restarts on a failed liveness probe, but only stops routing on a failed
 * readiness probe. Collapsing them into one endpoint turns a transient
 * database blip into a restart loop.
 *
 * `checks` grows as dependencies arrive — the vector store and the LLM
 * provider join it in M3 and M5 (docs/04-data-and-api.md §2.5).
 */
export const readinessResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    database: dependencyCheckSchema,
  }),
});

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
