import { z } from 'zod';

/** Query contract for `GET /documents` (docs/04-data-and-api.md §2.3). */
export const documentStatusSchema = z.enum([
  'queued',
  'parsing',
  'chunking',
  'embedding',
  'ready',
  'failed',
]);

export const listDocumentsQuerySchema = z.object({
  /**
   * Cursor pagination, not offset. Offset shifts and duplicates rows when new
   * items are inserted at the head — which is exactly what a document list
   * does while an upload is in flight (docs/04 §2).
   */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: documentStatusSchema.optional(),
});

export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

/** Path parameter shared by every single-document route. */
export const documentIdParamSchema = z.object({
  id: z.uuid('That is not a valid document id.'),
});
