import type { Selectable } from 'kysely';
import { db } from '../db/pool.js';
import type { MessageCitationsTable } from '../db/schema.js';
import type { Executor } from './user.repository.js';

export interface Citation {
  id: string;
  messageId: string;
  chunkId: string;
  documentId: string;
  citationIndex: number;
  score: number;
  contentSnapshot: string;
}

function toCitation(row: Selectable<MessageCitationsTable>): Citation {
  return {
    id: row.id,
    messageId: row.message_id,
    chunkId: row.chunk_id,
    documentId: row.document_id,
    citationIndex: row.citation_index,
    score: row.score,
    contentSnapshot: row.content_snapshot,
  };
}

export interface CitationInput {
  chunkId: string;
  documentId: string;
  citationIndex: number;
  score: number;
  contentSnapshot: string;
}

/**
 * SQL for `message_citations`.
 *
 * The table is the fourth of §5's five hallucination defences — "the cited
 * chunk's text is persisted with the message, so verification is a click and
 * remains possible after the document is deleted."
 *
 * Not owner-scoped, unlike every other repository here, and that is
 * deliberate: a citation has no `user_id` column. Ownership is enforced one
 * level up, because a citation is only ever reached through a message the
 * caller already proved they own. Adding a fifth denormalized `user_id` would
 * be a column kept correct by hand to re-check something already checked.
 */
export const citationRepository = {
  /**
   * Writes a message's citations.
   *
   * One statement, and `ON CONFLICT DO NOTHING` on `(message_id,
   * citation_index)` — a regenerate that re-finalizes the same message must
   * not fail on a constraint, and the citation for `[2]` is the same row
   * whichever attempt wrote it.
   */
  async createMany(
    messageId: string,
    citations: CitationInput[],
    executor: Executor = db,
  ): Promise<Citation[]> {
    if (citations.length === 0) return [];

    const rows = await executor
      .insertInto('message_citations')
      .values(
        citations.map((citation) => ({
          message_id: messageId,
          chunk_id: citation.chunkId,
          document_id: citation.documentId,
          citation_index: citation.citationIndex,
          score: citation.score,
          content_snapshot: citation.contentSnapshot,
        })),
      )
      .onConflict((builder) => builder.columns(['message_id', 'citation_index']).doNothing())
      .returningAll()
      .execute();

    return rows.map(toCitation);
  },

  /** A message's citations, in the order the user sees them. */
  async findByMessage(messageId: string, executor: Executor = db): Promise<Citation[]> {
    const rows = await executor
      .selectFrom('message_citations')
      .selectAll()
      .where('message_id', '=', messageId)
      .orderBy('citation_index')
      .execute();

    return rows.map(toCitation);
  },

  /**
   * Citations for a whole thread, grouped by message.
   *
   * One query rather than one per message: a fifty-message thread would
   * otherwise be fifty round trips to render a page that is already loaded.
   */
  async findByConversation(
    conversationId: string,
    userId: string,
    executor: Executor = db,
  ): Promise<Map<string, Citation[]>> {
    const rows = await executor
      .selectFrom('message_citations')
      .innerJoin('messages', 'messages.id', 'message_citations.message_id')
      .selectAll('message_citations')
      .where('messages.conversation_id', '=', conversationId)
      // Ownership is proved by the join, not by a column on this table.
      .where('messages.user_id', '=', userId)
      .orderBy('message_citations.citation_index')
      .execute();

    const grouped = new Map<string, Citation[]>();

    for (const row of rows) {
      const citation = toCitation(row);
      const existing = grouped.get(citation.messageId);
      if (existing) existing.push(citation);
      else grouped.set(citation.messageId, [citation]);
    }

    return grouped;
  },

  async deleteByMessage(messageId: string, executor: Executor = db): Promise<number> {
    const result = await executor
      .deleteFrom('message_citations')
      .where('message_id', '=', messageId)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  },
};
