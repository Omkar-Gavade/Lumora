import { sql, type Selectable } from 'kysely';
import { db } from '../db/pool.js';
import type { KnowledgeBasesTable } from '../db/schema.js';
import type { Executor } from './user.repository.js';

export interface KnowledgeBase {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A row plus the derived count selected alongside it. */
type KnowledgeBaseRow = Selectable<KnowledgeBasesTable> & { document_count: number };

/**
 * Members of this base, counted at query time.
 *
 * A stored counter would need maintaining on add, on remove, and on every
 * document delete that cascades — three places to forget, and the symptom of
 * forgetting is a number the user can see is wrong.
 */
const DOCUMENT_COUNT = sql<number>`(
  SELECT count(*)
  FROM knowledge_base_documents
  WHERE knowledge_base_documents.knowledge_base_id = knowledge_bases.id
)`;

function toKnowledgeBase(row: KnowledgeBaseRow): KnowledgeBase {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    // `count(*)` is a bigint, but the INT8 parser installed in `db/pool.ts`
    // hands it over already coerced, so the value is a number by the time it
    // reaches here.
    documentCount: row.document_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * SQL for `knowledge_bases` and its membership table.
 *
 * **Every method takes `userId` and scopes on it**, exactly as
 * `conversationRepository` and `documentRepository` do: a cross-tenant read
 * returns no row, the service raises `NotFoundError`, and the caller cannot
 * tell "someone else's knowledge base" from "no such knowledge base". There is
 * no unscoped lookup, because offering one makes the unsafe call the
 * convenient one.
 */
export const knowledgeBaseRepository = {
  async create(
    userId: string,
    input: { name: string; description?: string | undefined },
    executor: Executor = db,
  ): Promise<KnowledgeBase> {
    const row = await executor
      .insertInto('knowledge_bases')
      .values({
        user_id: userId,
        name: input.name,
        description: input.description ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toKnowledgeBase({ ...row, document_count: 0 });
  },

  async findById(id: string, userId: string, executor: Executor = db): Promise<KnowledgeBase | null> {
    const row = await executor
      .selectFrom('knowledge_bases')
      .selectAll()
      .select(DOCUMENT_COUNT.as('document_count'))
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return row === undefined ? null : toKnowledgeBase(row);
  },

  async listByUser(userId: string, executor: Executor = db): Promise<KnowledgeBase[]> {
    const rows = await executor
      .selectFrom('knowledge_bases')
      .selectAll()
      .select(DOCUMENT_COUNT.as('document_count'))
      .where('user_id', '=', userId)
      // Matches `knowledge_bases_by_user_idx`.
      .orderBy('updated_at', 'desc')
      .execute();

    return rows.map(toKnowledgeBase);
  },

  async update(
    id: string,
    userId: string,
    changes: { name?: string | undefined; description?: string | null | undefined },
    executor: Executor = db,
  ): Promise<KnowledgeBase | null> {
    const row = await executor
      .updateTable('knowledge_bases')
      .set({
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      // The ownership check is part of the write, not a read before it. A
      // check-then-act pair is a race; this is one statement that affects zero
      // rows when the base is not the caller's.
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();

    if (row === undefined) return null;

    return this.findById(id, userId, executor);
  },

  /** Returns false when the base does not exist or is not the caller's. */
  async delete(id: string, userId: string, executor: Executor = db): Promise<boolean> {
    const result = await executor
      .deleteFrom('knowledge_bases')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  },

  /**
   * Adds documents to a base, atomically and ownership-safely.
   *
   * **The ownership check is inside the statement** (docs/07 §8.1). The obvious
   * implementation — read the documents, verify each `user_id`, then insert —
   * is a check-then-act race, and the thing it races with is a document being
   * transferred or deleted between the two steps. Here a document that is not
   * the caller's contributes no row, because the `SELECT` feeding the insert
   * filters on `user_id`, and the base itself is verified by the same
   * predicate.
   *
   * `ON CONFLICT DO NOTHING` against the composite primary key makes the call
   * idempotent: re-adding a member is a no-op rather than an error.
   *
   * Returns the ids actually inserted. A caller comparing that count against
   * what it asked for learns that something was rejected — without being told
   * which, which is what keeps another user's document ids unguessable.
   */
  async addDocuments(
    knowledgeBaseId: string,
    userId: string,
    documentIds: string[],
    executor: Executor = db,
  ): Promise<string[]> {
    if (documentIds.length === 0) return [];

    const result = await sql<{ document_id: string }>`
      INSERT INTO knowledge_base_documents (knowledge_base_id, document_id)
      SELECT ${knowledgeBaseId}::uuid, d.id
        FROM documents AS d
       WHERE d.id = ANY(${sql.val(documentIds)}::uuid[])
         AND d.user_id = ${userId}
         AND EXISTS (
               SELECT 1 FROM knowledge_bases AS kb
                WHERE kb.id = ${knowledgeBaseId}::uuid
                  AND kb.user_id = ${userId}
             )
      ON CONFLICT DO NOTHING
      RETURNING document_id
    `.execute(executor);

    return result.rows.map((row) => row.document_id);
  },

  /**
   * How many of these documents are already members.
   *
   * Asked separately from the insert because `ON CONFLICT DO NOTHING` cannot
   * distinguish "already there" from "not allowed" — both return no row, and
   * reporting them as the same thing would tell a user their document was
   * rejected when it was simply already filed.
   */
  async countExistingMemberships(
    knowledgeBaseId: string,
    userId: string,
    documentIds: string[],
    executor: Executor = db,
  ): Promise<number> {
    if (documentIds.length === 0) return 0;

    const row = await executor
      .selectFrom('knowledge_base_documents as kbd')
      .innerJoin('knowledge_bases as kb', 'kb.id', 'kbd.knowledge_base_id')
      .innerJoin('documents as d', 'd.id', 'kbd.document_id')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('kbd.knowledge_base_id', '=', knowledgeBaseId)
      .where('kb.user_id', '=', userId)
      .where('d.user_id', '=', userId)
      .where('kbd.document_id', 'in', documentIds)
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  },

  /**
   * Removes one membership. Never touches the document itself.
   *
   * The join through `knowledge_bases` is what scopes the delete: without it a
   * caller could delete a membership row belonging to another user's base by
   * naming its id.
   */
  async removeDocument(
    knowledgeBaseId: string,
    userId: string,
    documentId: string,
    executor: Executor = db,
  ): Promise<boolean> {
    const result = await sql<{ document_id: string }>`
      DELETE FROM knowledge_base_documents AS kbd
       USING knowledge_bases AS kb
       WHERE kbd.knowledge_base_id = kb.id
         AND kb.id = ${knowledgeBaseId}::uuid
         AND kb.user_id = ${userId}
         AND kbd.document_id = ${documentId}::uuid
      RETURNING kbd.document_id
    `.execute(executor);

    return result.rows.length > 0;
  },

  /**
   * The document ids in a base — the retrieval scope.
   *
   * Scoped on the base's owner *and* on each document's owner. The second
   * predicate is redundant while `addDocuments` is the only writer, and it
   * stays because this is the query whose result is handed to retrieval: a
   * defence that costs an index lookup is worth keeping on the path where a
   * mistake becomes another user's document in an answer.
   */
  async documentIdsIn(
    knowledgeBaseId: string,
    userId: string,
    executor: Executor = db,
  ): Promise<string[]> {
    const rows = await executor
      .selectFrom('knowledge_base_documents as kbd')
      .innerJoin('knowledge_bases as kb', 'kb.id', 'kbd.knowledge_base_id')
      .innerJoin('documents as d', 'd.id', 'kbd.document_id')
      .select('kbd.document_id as document_id')
      .where('kbd.knowledge_base_id', '=', knowledgeBaseId)
      .where('kb.user_id', '=', userId)
      .where('d.user_id', '=', userId)
      .orderBy('kbd.created_at', 'asc')
      .execute();

    return rows.map((row) => row.document_id);
  },

  /** How many conversations would become unscoped if this base were deleted. */
  async countScopedConversations(
    knowledgeBaseId: string,
    userId: string,
    executor: Executor = db,
  ): Promise<number> {
    const row = await executor
      .selectFrom('conversations')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('knowledge_base_id', '=', knowledgeBaseId)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  },
};
