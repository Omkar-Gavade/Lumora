import type {
  ConversationDetailDto,
  ConversationDto,
  ConversationListDto,
  MessageDto,
  CitationDto,
} from '@lumora/shared';
import { db } from '../../db/pool.js';
import { ConflictError, NotFoundError } from '../../domain/errors/index.js';
import { logger } from '../../lib/logger.js';
import { knowledgeBaseService } from '../knowledge/knowledge-base.service.js';
import { citationRepository, type Citation } from '../../repositories/citation.repository.js';
import {
  conversationRepository,
  type Conversation,
} from '../../repositories/conversation.repository.js';
import { messageRepository, type Message } from '../../repositories/message.repository.js';

/**
 * Conversation CRUD (docs/04-data-and-api.md §2.4).
 *
 * Separate from `chatService` because the two have nothing in common but a
 * table: this is list/read/rename/archive/delete, and that is retrieval, prompt
 * assembly, and generation. Merging them would put a `NotFoundError` for a
 * renamed thread in the same file as token budgeting.
 */
export const conversationService = {
  /**
   * Creates a conversation, optionally scoped to a Knowledge Base.
   *
   * The base is verified to be the caller's *before* the insert, so a foreign
   * id fails as a 404 rather than being written and silently ignored at
   * retrieval time.
   */
  async create(
    userId: string,
    title?: string,
    knowledgeBaseId?: string | null,
  ): Promise<ConversationDto> {
    if (knowledgeBaseId != null) {
      await knowledgeBaseService.requireOwned(userId, knowledgeBaseId);
    }

    const conversation = await conversationRepository.create(userId, title, knowledgeBaseId);
    logger.info(
      { userId, conversationId: conversation.id, scoped: knowledgeBaseId != null },
      'Conversation created',
    );

    return toConversationDto(conversation);
  },

  /**
   * Changes the retrieval scope, which is only allowed before the first turn
   * (docs/07 §2.2).
   *
   * Enforced here **and** in SQL. The `WHERE message_count = 0` guard in the
   * repository is what makes it correct under a race with a turn in flight;
   * this layer exists to turn the resulting empty update into the right error,
   * which needs a follow-up read to tell "not yours" (404) from "too late"
   * (409).
   */
  async setKnowledgeBase(
    userId: string,
    conversationId: string,
    knowledgeBaseId: string | null,
  ): Promise<ConversationDto> {
    if (knowledgeBaseId !== null) {
      await knowledgeBaseService.requireOwned(userId, knowledgeBaseId);
    }

    const updated = await conversationRepository.setKnowledgeBase(
      conversationId,
      userId,
      knowledgeBaseId,
    );

    if (updated !== null) return toConversationDto(updated);

    const existing = await conversationRepository.findById(conversationId, userId);
    if (existing === null) throw new NotFoundError('Conversation not found.');

    throw new ConflictError(
      'This conversation has already started, so its knowledge base cannot be changed. Start a new chat to use a different one.',
    );
  },

  async list(
    userId: string,
    options: { limit: number; cursor?: string | undefined; includeArchived?: boolean | undefined },
  ): Promise<ConversationListDto> {
    const page = await conversationRepository.list(userId, options);

    return { items: page.items.map(toConversationDto), nextCursor: page.nextCursor };
  },

  /**
   * A thread with its messages and citations.
   *
   * Three queries, not one per message: the citation lookup is grouped by
   * message in a single join, because a fifty-turn thread would otherwise be
   * fifty round trips to render a page.
   */
  async detail(userId: string, conversationId: string): Promise<ConversationDetailDto> {
    const conversation = await conversationRepository.findById(conversationId, userId);
    if (conversation === null) throw new NotFoundError('That conversation does not exist.');

    const [messages, citationsByMessage] = await Promise.all([
      messageRepository.listByConversation(conversationId, userId),
      citationRepository.findByConversation(conversationId, userId),
    ]);

    const documentTitles = await titlesFor(citationsByMessage);

    return {
      conversation: toConversationDto(conversation),
      messages: messages.map((message) =>
        toMessageDto(message, citationsByMessage.get(message.id) ?? [], documentTitles),
      ),
    };
  },

  async update(
    userId: string,
    conversationId: string,
    changes: { title?: string | undefined; archived?: boolean | undefined },
  ): Promise<ConversationDto> {
    const updated = await conversationRepository.update(conversationId, userId, changes);
    if (updated === null) throw new NotFoundError('That conversation does not exist.');

    return toConversationDto(updated);
  },

  async delete(userId: string, conversationId: string): Promise<void> {
    const deleted = await conversationRepository.deleteById(conversationId, userId);
    if (!deleted) throw new NotFoundError('That conversation does not exist.');

    logger.info({ userId, conversationId }, 'Conversation deleted');
  },

  /** `DELETE /messages/:id` — removes the turn pair (docs §2.4). */
  async deleteMessage(userId: string, messageId: string): Promise<void> {
    const removed = await messageRepository.deleteTurn(messageId, userId);
    if (removed === 0) throw new NotFoundError('That message does not exist.');
  },
};

export function toConversationDto(conversation: Conversation): ConversationDto {
  return {
    id: conversation.id,
    title: conversation.title,
    titleGenerated: conversation.titleGenerated,
    messageCount: conversation.messageCount,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    // A boolean on the wire rather than the timestamp: no client needs to know
    // *when* a thread was archived, and exposing it invites a UI that shows it.
    archived: conversation.archivedAt !== null,
    knowledgeBaseId: conversation.knowledgeBaseId,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

export function toMessageDto(
  message: Message,
  citations: Citation[],
  documentTitles: Map<string, string>,
): MessageDto {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    status: message.status,
    sequence: message.sequence,
    parentId: message.parentId,
    model: message.model,
    errorCode: message.errorCode,
    finishReason: message.finishReason,
    citations: citations.map((citation) => toCitationDto(citation, documentTitles)),
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * A citation on the wire.
 *
 * `documentTitle` is `null` when the document has been deleted, and the
 * snapshot is still present — that asymmetry is the whole point of §5's fourth
 * defence: "verification is a click and remains possible after the document is
 * deleted."
 *
 * `pageNumber` and `sectionPath` are `null` here because they live on the
 * chunk, which cascades away with the document. Reading them would mean a
 * fourth query for a label; the snapshot carries the substance.
 */
function toCitationDto(citation: Citation, documentTitles: Map<string, string>): CitationDto {
  return {
    citationIndex: citation.citationIndex,
    chunkId: citation.chunkId,
    documentId: citation.documentId,
    documentTitle: documentTitles.get(citation.documentId) ?? null,
    pageNumber: null,
    sectionPath: null,
    score: citation.score,
    contentSnapshot: citation.contentSnapshot,
  };
}

/**
 * Document titles for a thread's citations, in one query.
 *
 * A left-ish lookup by design: a citation whose document was deleted simply has
 * no entry, and `toCitationDto` renders `null` rather than failing. That is the
 * ordinary case after a user cleans up their library, not an error.
 */
async function titlesFor(citationsByMessage: Map<string, Citation[]>): Promise<Map<string, string>> {
  const documentIds = new Set<string>();
  for (const citations of citationsByMessage.values()) {
    for (const citation of citations) documentIds.add(citation.documentId);
  }

  if (documentIds.size === 0) return new Map();

  const rows = await db
    .selectFrom('documents')
    .select(['id', 'filename'])
    .where('id', 'in', [...documentIds])
    .execute();

  return new Map(rows.map((row) => [row.id, row.filename]));
}
