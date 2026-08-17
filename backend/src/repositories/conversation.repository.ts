import { sql, type Selectable } from 'kysely';
import { db } from '../db/pool.js';
import type { ConversationsTable } from '../db/schema.js';
import type { Executor } from './user.repository.js';

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  titleGenerated: boolean;
  summary: string | null;
  summaryUptoSeq: number | null;
  messageCount: number;
  lastMessageAt: Date | null;
  archivedAt: Date | null;
  /** Retrieval scope (docs/07 §5). `null` is unscoped — the whole corpus. */
  knowledgeBaseId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toConversation(row: Selectable<ConversationsTable>): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    titleGenerated: row.title_generated,
    summary: row.summary,
    summaryUptoSeq: row.summary_upto_seq,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
    archivedAt: row.archived_at,
    knowledgeBaseId: row.knowledge_base_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListConversationsOptions {
  limit: number;
  cursor?: string | undefined;
  /** Include archived threads. Off by default — the sidebar shows active ones. */
  includeArchived?: boolean | undefined;
}

/**
 * SQL for `conversations`.
 *
 * **Every method takes `userId` and scopes on it**, exactly as
 * `documentRepository` does and for the same reason (docs/04-data-and-api.md
 * §4): a cross-tenant read returns no row, the service raises `NotFoundError`,
 * and the caller cannot distinguish "someone else's conversation" from "no such
 * conversation". A 403 would confirm the id is real, which is what an IDOR
 * probe is looking for.
 *
 * There is no unscoped `findById`. Offering one makes the unsafe call the
 * convenient default.
 */
export const conversationRepository = {
  /**
   * Creates a thread, optionally with a caller-supplied title.
   *
   * A supplied title sets `title_generated`, which reads oddly and is exactly
   * right: the flag means "this thread has a real name", not "a model wrote
   * it". Without that, the titler would see an untitled thread and rename a
   * conversation the user had just named — the same bug the guard on
   * `setGeneratedTitle` exists to prevent, arriving through the other door.
   */
  async create(
    userId: string,
    title: string | undefined,
    knowledgeBaseId: string | null | undefined,
    executor: Executor = db,
  ): Promise<Conversation> {
    const row = await executor
      .insertInto('conversations')
      .values({
        user_id: userId,
        ...(title === undefined ? {} : { title, title_generated: true }),
        // Undefined and null both mean unscoped; the column defaults to null.
        ...(knowledgeBaseId == null ? {} : { knowledge_base_id: knowledgeBaseId }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toConversation(row);
  },

  async findById(id: string, userId: string, executor: Executor = db): Promise<Conversation | null> {
    const row = await executor
      .selectFrom('conversations')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return row ? toConversation(row) : null;
  },

  /**
   * One page, most recently active first.
   *
   * Keyset pagination on `(last_message_at, id)`, not offset — a conversation
   * list reorders as threads are used, so offset page 2 silently repeats and
   * skips rows (docs/04 §2).
   *
   * `last_message_at` is nullable for a thread created but never used, and the
   * cursor handles that: nulls sort last, and once the cursor has a timestamp
   * every null row is already behind it.
   */
  async list(
    userId: string,
    options: ListConversationsOptions,
    executor: Executor = db,
  ): Promise<{ items: Conversation[]; nextCursor: string | null }> {
    let query = executor
      .selectFrom('conversations')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy(sql`last_message_at DESC NULLS LAST`)
      .orderBy('id', 'desc')
      .limit(options.limit + 1);

    if (options.includeArchived !== true) query = query.where('archived_at', 'is', null);

    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('last_message_at', '<', cursor.lastMessageAt),
          eb.and([
            eb('last_message_at', '=', cursor.lastMessageAt),
            eb('id', '<', cursor.id),
          ]),
          // Rows with no activity sort after every row that has some.
          eb('last_message_at', 'is', null),
        ]),
      );
    }

    const rows = await query.execute();
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map(toConversation),
      nextCursor:
        hasMore && last?.last_message_at ? encodeCursor(last.last_message_at, last.id) : null,
    };
  },

  /** Renames or archives. Both are `PATCH /conversations/:id` (docs §2.4). */
  async update(
    id: string,
    userId: string,
    changes: { title?: string | undefined; archived?: boolean | undefined },
    executor: Executor = db,
  ): Promise<Conversation | null> {
    const row = await executor
      .updateTable('conversations')
      .set({
        ...(changes.title === undefined
          ? {}
          : // A user-chosen title is never overwritten by the titler, so
            // renaming also marks the title as generated.
            { title: changes.title, title_generated: true }),
        ...(changes.archived === undefined
          ? {}
          : { archived_at: changes.archived ? new Date().toISOString() : null }),
      })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();

    return row ? toConversation(row) : null;
  },

  /**
   * Sets the retrieval scope, but only while the thread has no messages.
   *
   * **The freeze is `message_count = 0` in the `WHERE` clause** (docs/07 §2.2),
   * not a read followed by a write. A turn in flight increments the count in
   * SQL, so a scope change racing the first message must lose — and a
   * read-then-write lets it win, leaving a transcript whose citations were
   * retrieved under a scope the row no longer claims.
   *
   * Returns `null` when the conversation is not the caller's *or* already has
   * messages. The service distinguishes the two with a follow-up read, because
   * only one of them is a conflict and the other is a 404.
   */
  async setKnowledgeBase(
    id: string,
    userId: string,
    knowledgeBaseId: string | null,
    executor: Executor = db,
  ): Promise<Conversation | null> {
    const row = await executor
      .updateTable('conversations')
      .set({ knowledge_base_id: knowledgeBaseId })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('message_count', '=', 0)
      .returningAll()
      .executeTakeFirst();

    return row ? toConversation(row) : null;
  },

  /**
   * Sets a generated title, but only if the user has not chosen one.
   *
   * Guarded on `title_generated = false` in the `WHERE` clause rather than by a
   * preceding read: titling is fire-and-forget and runs concurrently with the
   * rest of the turn (§7 step 13), so a user who renames the thread while the
   * titler is in flight must win. A read-then-write lets the titler overwrite
   * them.
   */
  async setGeneratedTitle(
    id: string,
    userId: string,
    title: string,
    executor: Executor = db,
  ): Promise<Conversation | null> {
    const row = await executor
      .updateTable('conversations')
      .set({ title, title_generated: true })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('title_generated', '=', false)
      .returningAll()
      .executeTakeFirst();

    return row ? toConversation(row) : null;
  },

  /**
   * Records that a turn happened.
   *
   * `message_count` is incremented in SQL rather than written from a value the
   * caller computed, so two turns committing concurrently cannot both read 4
   * and both write 5.
   */
  async recordActivity(
    id: string,
    userId: string,
    addedMessages: number,
    executor: Executor = db,
  ): Promise<void> {
    await executor
      .updateTable('conversations')
      .set((eb) => ({
        message_count: eb('message_count', '+', addedMessages),
        last_message_at: sql<string>`now()`,
      }))
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .execute();
  },

  /** Hard delete; messages and citations cascade. */
  async deleteById(id: string, userId: string, executor: Executor = db): Promise<boolean> {
    const result = await executor
      .deleteFrom('conversations')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return Number(result.numDeletedRows) === 1;
  },
};

interface Cursor {
  lastMessageAt: Date;
  id: string;
}

/** Opaque by design — the shape is not part of the API contract. */
function encodeCursor(lastMessageAt: Date, id: string): string {
  return Buffer.from(`${lastMessageAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) return null;

  try {
    const [timestamp, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!timestamp || !id) return null;

    const lastMessageAt = new Date(timestamp);
    if (Number.isNaN(lastMessageAt.getTime())) return null;

    return { lastMessageAt, id };
  } catch {
    // A malformed cursor returns the first page rather than an error: it is
    // opaque, so a client cannot repair one, and a 422 on a stale bookmark is
    // worse than starting over.
    return null;
  }
}
