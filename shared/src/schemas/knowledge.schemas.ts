import { z } from 'zod';

/**
 * Knowledge Base contracts (docs/07-knowledge-base.md §7).
 *
 * A Knowledge Base is a named subset of a user's documents that a conversation
 * can be scoped to. Nothing here describes chunks, vectors, or retrieval — the
 * scope is resolved server-side into a document list the existing pipeline
 * already accepts.
 */

export const KB_NAME_MAX_LENGTH = 80;
export const KB_DESCRIPTION_MAX_LENGTH = 280;

/**
 * How many documents may be added in one call.
 *
 * Matches the cap already applied to `documentIds` on the search endpoint, so
 * the two places a user can name a set of documents agree on how large a set
 * may be.
 */
export const MAX_DOCUMENTS_PER_REQUEST = 50;

export const knowledgeBaseNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the knowledge base a name.')
  .max(KB_NAME_MAX_LENGTH, `Keep the name under ${String(KB_NAME_MAX_LENGTH)} characters.`);

export const knowledgeBaseDescriptionSchema = z
  .string()
  .trim()
  .max(
    KB_DESCRIPTION_MAX_LENGTH,
    `Keep the description under ${String(KB_DESCRIPTION_MAX_LENGTH)} characters.`,
  );

/** `POST /knowledge-bases` */
export const createKnowledgeBaseSchema = z.object({
  name: knowledgeBaseNameSchema,
  description: knowledgeBaseDescriptionSchema.optional(),
});

export type CreateKnowledgeBaseRequest = z.infer<typeof createKnowledgeBaseSchema>;

/**
 * `PATCH /knowledge-bases/:id`
 *
 * Both fields optional, but at least one required — a PATCH that changes
 * nothing is a client bug, and answering 200 hides it. `description: null`
 * clears it, which is distinct from omitting the field.
 */
export const updateKnowledgeBaseSchema = z
  .object({
    name: knowledgeBaseNameSchema.optional(),
    description: knowledgeBaseDescriptionSchema.nullable().optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.description !== undefined,
    'Provide a name or a description to update.',
  );

export type UpdateKnowledgeBaseRequest = z.infer<typeof updateKnowledgeBaseSchema>;

/** `POST /knowledge-bases/:id/documents` — batch, idempotent. */
export const addKnowledgeBaseDocumentsSchema = z.object({
  documentIds: z
    .array(z.uuid())
    .min(1, 'Select at least one document.')
    .max(
      MAX_DOCUMENTS_PER_REQUEST,
      `Add at most ${String(MAX_DOCUMENTS_PER_REQUEST)} documents at a time.`,
    ),
});

export type AddKnowledgeBaseDocumentsRequest = z.infer<typeof addKnowledgeBaseDocumentsSchema>;

export const knowledgeBaseIdParamSchema = z.object({
  id: z.uuid('That knowledge base id is not valid.'),
});

/** `DELETE /knowledge-bases/:id/documents/:documentId` */
export const knowledgeBaseDocumentParamSchema = z.object({
  id: z.uuid('That knowledge base id is not valid.'),
  documentId: z.uuid('That document id is not valid.'),
});
