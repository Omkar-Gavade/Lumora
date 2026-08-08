import { expect } from 'vitest';
import type { Response } from 'supertest';
import type { ZodType } from 'zod';
import type { ErrorCode } from '@lumora/shared';

/**
 * Asserts a response body against a shared Zod schema.
 *
 * docs/03-backend.md §9: "every response validated against the shared Zod
 * schema in tests, so an accidental field rename fails the backend test suite
 * rather than the frontend at runtime".
 *
 * The schema comes from `@lumora/shared` — the same object the frontend parses
 * with. Re-describing the shape here would create a second definition that can
 * drift from the contract, which is the exact failure this is meant to catch.
 *
 * Returns the parsed value so a test can go on to assert on fields with the
 * narrowed type rather than casting.
 */
export function expectSchema<T>(response: Response, schema: ZodType<T>): T {
  const result = schema.safeParse(response.body);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Response does not match the shared contract:\n${issues}\n--- body ---\n${JSON.stringify(response.body, null, 2)}`,
    );
  }

  return result.data;
}

/**
 * Asserts the uniform error envelope (docs/03-backend.md §4).
 *
 * Checks the shape as well as the code, because the envelope is what the
 * frontend's API client parses: a handler that returns `{ message }` at the
 * top level instead of `{ error: { … } }` would still carry the right status
 * and break every consumer.
 */
export function expectApiError(response: Response, status: number, code: ErrorCode): void {
  expect(response.status).toBe(status);

  expect(response.body).toMatchObject({
    error: {
      code,
      message: expect.any(String),
      requestId: expect.any(String),
    },
  });

  // `details` must be present — as `null` when there is nothing to say. An
  // absent key and an explicit null are different to a typed client.
  expect(response.body).toHaveProperty('error.details');

  // The generic message must never carry a stack, a SQL fragment, or a
  // provider reply. A leak here is the failure mode the envelope exists to
  // prevent, and it would otherwise be invisible in a passing test.
  const message = (response.body as { error: { message: string } }).error.message;
  expect(message).not.toMatch(/\bat .+:\d+:\d+/); // stack frame
  expect(message).not.toMatch(/\b(select|insert|update|delete)\b .*\bfrom\b/i);
}

/** Asserts a 204: no body, no content-type. */
export function expectNoContent(response: Response): void {
  expect(response.status).toBe(204);
  expect(response.text).toBeFalsy();
}
