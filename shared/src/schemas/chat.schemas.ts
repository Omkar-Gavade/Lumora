import { z } from 'zod';

/**
 * Longest message a user may send.
 *
 * docs/05-rag-and-chat.md §4.1 allocates 500 tokens to the question, and the
 * prompt builder truncates rather than refuses at that line. This ceiling is
 * much higher and exists for a different reason: it bounds what reaches the
 * server at all, so a pasted document cannot be sent as a "question".
 */
export const MAX_MESSAGE_LENGTH = 8_000;

export const MAX_CONVERSATION_TITLE_LENGTH = 120;

export const messageContentSchema = z
  .string()
  .trim()
  .min(1, 'Type a question first.')
  .max(MAX_MESSAGE_LENGTH, `Keep your message under ${String(MAX_MESSAGE_LENGTH)} characters.`);

/** `POST /conversations` — an empty body is valid; the title is optional. */
export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(MAX_CONVERSATION_TITLE_LENGTH).optional(),
});

export type CreateConversationRequest = z.infer<typeof createConversationSchema>;

/**
 * `PATCH /conversations/:id` — rename and archive, per docs §2.4.
 *
 * `refine` rather than two endpoints: both are small mutations on the same
 * resource, and an empty patch is a client bug worth naming rather than a
 * no-op worth silently accepting.
 */
export const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_CONVERSATION_TITLE_LENGTH).optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (value) => value.title !== undefined || value.archived !== undefined,
    'Provide a title or an archived flag.',
  );

export type UpdateConversationRequest = z.infer<typeof updateConversationSchema>;

/** `POST /conversations/:id/messages`. */
export const sendMessageSchema = z.object({
  content: messageContentSchema,
});

export type SendMessageRequest = z.infer<typeof sendMessageSchema>;

export const conversationIdParamSchema = z.object({
  id: z.uuid('That conversation id is not valid.'),
});

export const messageIdParamSchema = z.object({
  id: z.uuid('That message id is not valid.'),
});

export const listConversationsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Archived threads are hidden unless asked for. */
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
