import { sql, type Selectable } from 'kysely';
import { db } from '../db/pool.js';
import type { MessageRole, MessageStatus, MessagesTable } from '../db/schema.js';
import type { Executor } from './user.repository.js';

export interface Message {
  id: string;
  conversationId: string;
  userId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  sequence: number;
  parentId: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  finishReason: string | null;
  errorCode: string | null;
  createdAt: Date;
}

function toMessage(row: Selectable<MessagesTable>): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role,
    content: row.content,
    status: row.status,
    sequence: row.sequence,
    parentId: row.parent_id,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    latencyMs: row.latency_ms,
    finishReason: row.finish_reason,
    errorCode: row.error_code,
    createdAt: row.created_at,
  };
}

export interface AppendTurnInput {
  conversationId: string;
  userId: string;
  /** The user's question, verbatim. */
  question: string;
  /** Regeneration lineage: the assistant message this one replaces. */
  parentId?: string | null;
}

/**
 * SQL for `messages`.
 *
 * Owner-scoped throughout, like every other repository here. The denormalized
 * `user_id` is what makes that a predicate rather than a join on the hot path
 * (see migration 0006).
 */
export const messageRepository = {
  /**
   * Writes the user turn and the assistant placeholder **as one unit**.
   *
   * docs/05-rag-and-chat.md §7 step 3, and the doc is explicit about why:
   * "Step 3 is a transaction and step 11 persists partial output — together
   * these are what make the stream crash-safe. A design that only writes the
   * assistant message on successful completion loses everything on a
   * disconnect and leaves the thread with a user turn and no reply, which is
   * both a data bug and a visible product defect."
   *
   * The sequence numbers come from a subquery against the table rather than
   * from a count the caller holds, so two turns racing on the same thread
   * cannot both claim sequence 5 — the `UNIQUE (conversation_id, sequence)`
   * constraint then makes the loser fail loudly instead of silently
   * overwriting.
   */
  async appendTurn(
    input: AppendTurnInput,
    executor: Executor = db,
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    const next = await nextSequence(input.conversationId, executor);

    const userMessage = await executor
      .insertInto('messages')
      .values({
        conversation_id: input.conversationId,
        user_id: input.userId,
        role: 'user',
        content: input.question,
        status: 'complete',
        sequence: next,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const assistantMessage = await executor
      .insertInto('messages')
      .values({
        conversation_id: input.conversationId,
        user_id: input.userId,
        role: 'assistant',
        content: '',
        // `pending`, not `complete`: the row exists so a crash leaves a
        // recoverable placeholder rather than a thread with no reply.
        status: 'pending',
        sequence: next + 1,
        ...(input.parentId === undefined || input.parentId === null
          ? {}
          : { parent_id: input.parentId }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { userMessage: toMessage(userMessage), assistantMessage: toMessage(assistantMessage) };
  },

  /**
   * Appends a lone assistant placeholder — the regeneration path (§7).
   *
   * "Regeneration creates a new assistant message with `parent_id` pointing at
   * the replaced one rather than mutating in place, preserving lineage and
   * keeping the option of a version switcher without a schema change."
   */
  async appendAssistantPlaceholder(
    input: { conversationId: string; userId: string; parentId: string },
    executor: Executor = db,
  ): Promise<Message> {
    const row = await executor
      .insertInto('messages')
      .values({
        conversation_id: input.conversationId,
        user_id: input.userId,
        role: 'assistant',
        content: '',
        status: 'pending',
        sequence: await nextSequence(input.conversationId, executor),
        parent_id: input.parentId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toMessage(row);
  },

  /**
   * Fills in a placeholder once generation ends — successfully or not.
   *
   * One method for every terminal outcome (`complete`, `stopped`, `failed`)
   * because they differ only in the status and which fields are present, and
   * three near-identical writers would drift. `stopped` in particular must
   * persist whatever text arrived before the abort (§7 step 11).
   */
  async finalize(
    id: string,
    userId: string,
    input: {
      content: string;
      status: MessageStatus;
      model?: string | undefined;
      promptTokens?: number | undefined;
      completionTokens?: number | undefined;
      latencyMs?: number | undefined;
      finishReason?: string | undefined;
      errorCode?: string | null | undefined;
    },
    executor: Executor = db,
  ): Promise<Message | null> {
    const row = await executor
      .updateTable('messages')
      .set({
        content: input.content,
        status: input.status,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.promptTokens === undefined ? {} : { prompt_tokens: input.promptTokens }),
        ...(input.completionTokens === undefined
          ? {}
          : { completion_tokens: input.completionTokens }),
        ...(input.latencyMs === undefined ? {} : { latency_ms: input.latencyMs }),
        ...(input.finishReason === undefined ? {} : { finish_reason: input.finishReason }),
        ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
      })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      // Terminal states are never rewritten: a late-arriving handler must not
      // turn a `stopped` message back into `complete`, which is exactly what a
      // slow abort racing a finishing stream would do.
      .where('status', 'in', ['pending', 'streaming'] satisfies MessageStatus[])
      .returningAll()
      .executeTakeFirst();

    return row ? toMessage(row) : null;
  },

  /** Every message in a thread, oldest first — the documented ordering. */
  async listByConversation(
    conversationId: string,
    userId: string,
    executor: Executor = db,
  ): Promise<Message[]> {
    const rows = await executor
      .selectFrom('messages')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .orderBy('sequence')
      .execute();

    return rows.map(toMessage);
  },

  /**
   * The most recent complete turns, for the prompt's history block.
   *
   * Only `complete` messages: a failed or stopped reply is visible in the UI as
   * what happened, but feeding a half-finished answer back as context teaches
   * the model to produce half-finished answers.
   *
   * Fetched newest-first and reversed, so the `LIMIT` takes the *recent* turns
   * (§4.4: "Last 6 turns verbatim") while the caller receives them oldest-first
   * as the prompt needs them.
   */
  async recentHistory(
    conversationId: string,
    userId: string,
    limit: number,
    /**
     * Excludes the current turn.
     *
     * The user's question is written to the table *before* the prompt is built
     * (§7 step 3), so a history query with no upper bound returns it — and the
     * builder then puts it in the prompt twice, once as context and once as the
     * question. Bounding by sequence is exact, where filtering by id would have
     * to know about both rows the turn just created.
     */
    beforeSequence?: number,
    executor: Executor = db,
  ): Promise<Message[]> {
    if (limit <= 0) return [];

    let query = executor
      .selectFrom('messages')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .where('status', '=', 'complete')
      .where('content', '!=', '')
      .orderBy('sequence', 'desc')
      .limit(limit);

    if (beforeSequence !== undefined) query = query.where('sequence', '<', beforeSequence);

    return (await query.execute()).reverse().map(toMessage);
  },

  async findById(id: string, userId: string, executor: Executor = db): Promise<Message | null> {
    const row = await executor
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return row ? toMessage(row) : null;
  },

  /**
   * Deletes a turn pair — `DELETE /messages/:id` (docs §2.4).
   *
   * A user message and the assistant reply that follows it are one unit to the
   * person reading the thread; deleting only the question leaves an answer to
   * nothing.
   */
  async deleteTurn(id: string, userId: string, executor: Executor = db): Promise<number> {
    const target = await this.findById(id, userId, executor);
    if (target === null) return 0;

    const result = await executor
      .deleteFrom('messages')
      .where('conversation_id', '=', target.conversationId)
      .where('user_id', '=', userId)
      .where('sequence', 'in', [target.sequence, target.sequence + 1])
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  },
};

/**
 * The next free sequence number in a thread.
 *
 * `COALESCE(MAX(sequence), 0) + 1`, evaluated by Postgres inside whatever
 * transaction the caller opened. Computing it in application code from a
 * previous read would leave a window in which two turns pick the same number.
 */
async function nextSequence(conversationId: string, executor: Executor): Promise<number> {
  const row = await executor
    .selectFrom('messages')
    .select((eb) => eb.fn.coalesce(eb.fn.max('sequence'), sql<number>`0`).as('max'))
    .where('conversation_id', '=', conversationId)
    .executeTakeFirstOrThrow();

  return row.max + 1;
}
