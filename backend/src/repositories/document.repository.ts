import { sql, type Insertable, type Selectable } from 'kysely';
import type { DocumentStatus } from '@lumora/shared';
import type { DocumentsTable } from '../db/schema.js';
import { db } from '../db/pool.js';
import type { Document } from '../domain/entities/document.js';
import type { Executor } from './user.repository.js';

function toDocument(row: Selectable<DocumentsTable>): Document {
  return {
    id: row.id,
    userId: row.user_id,
    filename: row.filename,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    storageKey: row.storage_key,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    pageCount: row.page_count,
    chunkCount: row.chunk_count,
    tokenCount: row.token_count,
    embeddingModel: row.embedding_model,
    embeddingDims: row.embedding_dims,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateDocumentInput {
  userId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  storageKey: string;
}

export interface ListDocumentsOptions {
  limit: number;
  /** The `created_at`/`id` pair of the last item on the previous page. */
  cursor?: string | undefined;
  status?: DocumentStatus | undefined;
}

/**
 * SQL for `documents`.
 *
 * **Every method takes `userId` and scopes on it.** This is the primary tenancy
 * defence (docs/04-data-and-api.md §4): a cross-tenant read returns no row, so
 * the service raises `NotFoundError` and the caller cannot distinguish
 * "someone else's document" from "no such document". A 403 would confirm the
 * id is real, which is precisely what an IDOR probe is looking for.
 *
 * There is no `findById(id)` without an owner. Offering one would make the
 * unscoped call the convenient default, and the first caller to reach for it
 * introduces the vulnerability.
 */
export const documentRepository = {
  async create(input: CreateDocumentInput, executor: Executor = db): Promise<Document> {
    const values: Insertable<DocumentsTable> = {
      user_id: input.userId,
      filename: input.filename,
      original_name: input.originalName,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      content_hash: input.contentHash,
      storage_key: input.storageKey,
    };

    const row = await executor
      .insertInto('documents')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDocument(row);
  },

  async findById(id: string, userId: string, executor: Executor = db): Promise<Document | null> {
    const row = await executor
      .selectFrom('documents')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return row ? toDocument(row) : null;
  },

  /** Dedup lookup — the same bytes twice is one document (docs/05 §2.1). */
  async findByContentHash(
    userId: string,
    contentHash: string,
    executor: Executor = db,
  ): Promise<Document | null> {
    const row = await executor
      .selectFrom('documents')
      .selectAll()
      .where('user_id', '=', userId)
      .where('content_hash', '=', contentHash)
      .executeTakeFirst();

    return row ? toDocument(row) : null;
  },

  /**
   * One page, newest first, plus whether another page exists.
   *
   * **Keyset pagination, not offset.** A document list is the worst case for
   * offset: rows are inserted at the head while the user is reading, so page 2
   * of an offset query silently repeats items from page 1 and hides others
   * entirely (docs/04-data-and-api.md §2).
   *
   * The cursor is `createdAt|id` because `created_at` alone is not unique —
   * five files uploaded in one request share a millisecond, and a cursor that
   * cannot break the tie either drops or repeats them. `id` is a uuidv7, so it
   * sorts the same way `created_at` does and the tiebreak is stable.
   *
   * `limit + 1` rows are fetched so "is there more" needs no second query.
   */
  async list(
    userId: string,
    options: ListDocumentsOptions,
    executor: Executor = db,
  ): Promise<{ items: Document[]; nextCursor: string | null }> {
    let query = executor
      .selectFrom('documents')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit + 1);

    if (options.status) query = query.where('status', '=', options.status);

    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      // Row-value comparison, so the tiebreak is part of the index scan rather
      // than an OR the planner has to unpick.
      query = query.where((eb) =>
        eb.or([
          eb('created_at', '<', cursor.createdAt),
          eb.and([eb('created_at', '=', cursor.createdAt), eb('id', '<', cursor.id)]),
        ]),
      );
    }

    const rows = await query.execute();
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map(toDocument),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    };
  },

  /**
   * Deletes the row and returns it, so the caller has the storage key needed
   * to remove the bytes.
   *
   * Scoped by owner in the same statement: a delete that looked the row up
   * first and then deleted by id would have a window in which ownership could
   * change, and would need two round trips to close it.
   */
  async deleteById(id: string, userId: string, executor: Executor = db): Promise<Document | null> {
    const row = await executor
      .deleteFrom('documents')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();

    return row ? toDocument(row) : null;
  },

  /**
   * Moves a document to the next status, **only if it is in one of the states
   * that legally precede it**.
   *
   * The guard is in the `WHERE` clause rather than in a read-then-write, and
   * that is the entire point. Two workers can hold the same document — the
   * reaper reclaims a lease a moment before the original worker finishes, and
   * for a few seconds both believe they own it. A read followed by an update
   * lets both pass the check; a conditional update lets exactly one row match,
   * and the loser learns it lost from the return value.
   *
   * Returns the updated row, or `null` when the guard did not match. `null` is
   * not an error: on a retry it usually means another attempt already advanced
   * the document, and the correct response is to stop, not to fail.
   */
  async transitionStatus(
    id: string,
    userId: string,
    input: {
      from: readonly DocumentStatus[];
      to: DocumentStatus;
      pageCount?: number | undefined;
      tokenCount?: number | undefined;
      chunkCount?: number | undefined;
      /**
       * Recorded on the document, not globally (docs/05-rag-and-chat.md §2.4).
       *
       * "Embedding spaces are not comparable across models, and querying a
       * `text-embedding-3-small` index with a Gemini query vector returns
       * confident nonsense." Per-document means a provider change is
       * detectable and the affected documents can be re-indexed, rather than
       * silently degrading every answer.
       */
      embeddingModel?: string | undefined;
      embeddingDims?: number | undefined;
      processedAt?: Date | undefined;
    },
    executor: Executor = db,
  ): Promise<Document | null> {
    const row = await executor
      .updateTable('documents')
      .set({
        status: input.to,
        // Cleared on every successful transition. A stale error from a previous
        // attempt left on a row that is now progressing would show the user a
        // failure reason beside a live progress bar.
        error_code: null,
        error_message: null,
        updated_at: sql<string>`now()`,
        ...(input.pageCount === undefined ? {} : { page_count: input.pageCount }),
        ...(input.tokenCount === undefined ? {} : { token_count: input.tokenCount }),
        ...(input.chunkCount === undefined ? {} : { chunk_count: input.chunkCount }),
        ...(input.embeddingModel === undefined
          ? {}
          : { embedding_model: input.embeddingModel }),
        ...(input.embeddingDims === undefined ? {} : { embedding_dims: input.embeddingDims }),
        ...(input.processedAt === undefined
          ? {}
          : { processed_at: input.processedAt.toISOString() }),
      })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('status', 'in', input.from)
      .returningAll()
      .executeTakeFirst();

    return row ? toDocument(row) : null;
  },

  /**
   * Marks a document failed with the reason FR-13 requires on the row.
   *
   * Unguarded on the current status, unlike `transitionStatus`. A document can
   * fail from any working state, and refusing to record a failure because the
   * row moved underneath us would leave it stuck mid-pipeline with nothing to
   * explain it — the one outcome worse than a wrong-looking status.
   *
   * Terminal states are still excluded: a `ready` document must not be dragged
   * back to `failed` by a duplicate worker finishing late, and a second failure
   * must not overwrite the first, which is the one the user was shown.
   */
  async markFailed(
    id: string,
    userId: string,
    errorCode: string,
    errorMessage: string,
    executor: Executor = db,
  ): Promise<Document | null> {
    const row = await executor
      .updateTable('documents')
      .set({
        status: 'failed',
        error_code: errorCode,
        error_message: errorMessage.slice(0, 500),
        updated_at: sql<string>`now()`,
      })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('status', 'not in', ['ready', 'failed'] satisfies DocumentStatus[])
      .returningAll()
      .executeTakeFirst();

    return row ? toDocument(row) : null;
  },

  /**
   * Moves a `failed` document back into the pipeline (`POST /documents/:id/retry`).
   *
   * Separate from `transitionStatus` because this is the one legal move *out*
   * of a terminal state, and the state machine deliberately closes `failed`
   * to everything else. Giving retry its own method keeps that closure honest —
   * `canTransition` still says `failed → queued` is not a pipeline transition,
   * because it is not: it is a user action that resets the document.
   *
   * Guarded on `failed` in the `WHERE` clause, so two retry requests arriving
   * together enqueue one job rather than two.
   *
   * `chunk_count` and the embedding fields are **not** cleared. The pipeline is
   * convergent — a retry re-chunks over the existing rows and skips any chunk
   * that already has a vector — so wiping them would discard work that is
   * still valid and force a document that failed at embedding call 400 of 500
   * to pay for all 500 again.
   */
  async transitionStatusFromFailed(
    id: string,
    userId: string,
    to: DocumentStatus,
    executor: Executor = db,
  ): Promise<Document | null> {
    const row = await executor
      .updateTable('documents')
      .set({
        status: to,
        error_code: null,
        error_message: null,
        updated_at: sql<string>`now()`,
      })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('status', '=', 'failed')
      .returningAll()
      .executeTakeFirst();

    return row ? toDocument(row) : null;
  },

  /** FR-16: the numbers the quota check and the sidebar meter both read. */
  async usageFor(userId: string, executor: Executor = db): Promise<{ usedBytes: number; documentCount: number }> {
    const row = await executor
      .selectFrom('documents')
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<string>('size_bytes'), eb.val('0')).as('used_bytes'),
        eb.fn.countAll<number>().as('document_count'),
      ])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    return {
      // SUM over BIGINT comes back as a string; the total is bounded by the
      // per-user cap, so it is provably inside Number.MAX_SAFE_INTEGER.
      usedBytes: Number(row.used_bytes),
      documentCount: row.document_count,
    };
  },
};

interface Cursor {
  createdAt: Date;
  id: string;
}

/**
 * Opaque to the client on purpose.
 *
 * base64url of `timestamp|id`. Not encryption and not claimed to be: the
 * point is that the shape is not part of the API contract, so switching to
 * a different ordering later does not break clients that stored one.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) return null;

  try {
    const [timestamp, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!timestamp || !id) return null;

    const createdAt = new Date(timestamp);
    if (Number.isNaN(createdAt.getTime())) return null;

    return { createdAt, id };
  } catch {
    // A malformed cursor returns the first page rather than an error. It is
    // opaque, so a client cannot be expected to repair one, and a 422 on a
    // stale bookmark is a worse outcome than starting over.
    return null;
  }
}
