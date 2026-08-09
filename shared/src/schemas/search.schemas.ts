import { z } from 'zod';
import { MAX_QUERY_LENGTH, MAX_RESULTS, MIN_QUERY_LENGTH } from '../constants/search.js';

/**
 * The query string itself.
 *
 * Trimmed before length is checked, so a query of four spaces is rejected as
 * empty rather than accepted as four characters. The upper bound is enforced
 * here rather than truncated silently: a user who pasted too much should be
 * told, not have their question quietly cut in half.
 */
export const searchQuerySchema = z
  .string()
  .trim()
  .min(MIN_QUERY_LENGTH, 'Enter at least a couple of characters to search for.')
  .max(MAX_QUERY_LENGTH, `Keep your search under ${String(MAX_QUERY_LENGTH)} characters.`);

/**
 * Restricts retrieval to a subset of the user's corpus.
 *
 * Separate from the tenant scope, which is never a filter — ownership is
 * enforced by the per-user collection and by `user_id` on every lexical query,
 * not by anything a client can send.
 */
export const searchFiltersSchema = z.object({
  /** Search within specific documents only. Empty or absent means all. */
  documentIds: z.array(z.uuid()).max(50).optional(),
});

export type SearchFilters = z.infer<typeof searchFiltersSchema>;

/**
 * `POST /search` — the structured form.
 *
 * Exists alongside the GET because filters are a list, and a repeated query
 * parameter is a worse contract than a JSON array once there is more than one
 * of them.
 */
export const searchRequestSchema = z.object({
  query: searchQuerySchema,
  /**
   * Capped at the documented final K (§3.3: "Final K ≤ 6").
   *
   * A client asking for 50 would get a bundle that cannot fit the §4.1 context
   * budget, so the cap is part of the contract rather than a suggestion.
   */
  topK: z.coerce.number().int().min(1).max(MAX_RESULTS).optional(),
  filters: searchFiltersSchema.optional(),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;

/**
 * `GET /search` — the browser and curl form.
 *
 * `documentId` is repeatable (`?documentId=a&documentId=b`), which Express
 * surfaces as either a string or an array; both are normalized to an array so
 * the handler has one shape to read.
 */
export const searchQueryParamsSchema = z.object({
  q: searchQuerySchema,
  k: z.coerce.number().int().min(1).max(MAX_RESULTS).optional(),
  documentId: z
    .union([z.uuid(), z.array(z.uuid()).max(50)])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value])),
});

export type SearchQueryParams = z.infer<typeof searchQueryParamsSchema>;
