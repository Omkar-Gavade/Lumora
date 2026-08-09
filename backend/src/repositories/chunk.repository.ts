import { sql, type Selectable } from 'kysely';
import { db } from '../db/pool.js';
import type { DocumentChunksTable } from '../db/schema.js';
import type { Executor } from './user.repository.js';

export interface ChunkInput {
  documentId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  pageNumber: number | null;
  sectionPath: string | null;
  charStart: number;
  charEnd: number;
}

/** One lexical hit, joined to its document so a citation needs no second query. */
export interface LexicalHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  text: string;
  chunkIndex: number;
  tokenCount: number;
  pageNumber: number | null;
  sectionPath: string | null;
  /** `ts_rank_cd`. Meaningful only relative to other hits for the same query. */
  score: number;
}

/** The raw shape `searchLexical`'s SQL returns, before mapping. */
interface LexicalRow {
  id: string;
  document_id: string;
  document_title: string;
  content: string;
  chunk_index: number;
  token_count: number;
  page_number: number | null;
  section_path: string | null;
  rank: number | string;
}

/** A chunk row as the pipeline reads it back. */
export interface StoredChunk {
  id: string;
  documentId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  pageNumber: number | null;
  sectionPath: string | null;
  vectorId: string | null;
}

function toStoredChunk(row: Selectable<DocumentChunksTable>): StoredChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    userId: row.user_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    tokenCount: row.token_count,
    pageNumber: row.page_number,
    sectionPath: row.section_path,
    vectorId: row.vector_id,
  };
}

/**
 * SQL for `document_chunks`.
 *
 * **Everything here is built around one property: re-running the pipeline over
 * the same document must converge, not accumulate.** docs/03-backend.md §7 is
 * explicit — "a retry after a partial embedding run must not double-insert
 * vectors, so chunks are written with a deterministic id derived from
 * `(document_id, chunk_index)` and upserted."
 *
 * The chunker is deterministic, so attempt *n* produces byte-identical chunks
 * to attempt 1. Combined with the `UNIQUE (document_id, chunk_index)`
 * constraint, the upsert below turns a retry into a no-op that preserves the
 * existing row id — which matters because that id is stored in the vector
 * store's metadata as `chunkId`, and a new id per attempt would leave every
 * citation pointing at a row that no longer exists.
 */
export const chunkRepository = {
  /**
   * Writes chunks, overwriting any that already exist at the same index.
   *
   * `vector_id` is deliberately **not** in the `DO UPDATE` set. A retry that
   * re-chunks identical text must not discard the record of which vectors were
   * already written — that is exactly the state partial-embedding recovery
   * reads to decide what still needs embedding.
   *
   * One statement rather than a loop: a 200-page PDF is several hundred
   * chunks, and that many round trips inside a job holding a lease is how a
   * lease expires mid-write and a second worker starts the same document.
   */
  async upsertMany(chunks: ChunkInput[], executor: Executor = db): Promise<StoredChunk[]> {
    if (chunks.length === 0) return [];

    const rows = await executor
      .insertInto('document_chunks')
      .values(
        chunks.map((chunk) => ({
          document_id: chunk.documentId,
          user_id: chunk.userId,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          token_count: chunk.tokenCount,
          page_number: chunk.pageNumber,
          section_path: chunk.sectionPath,
          char_start: chunk.charStart,
          char_end: chunk.charEnd,
        })),
      )
      .onConflict((builder) =>
        builder.columns(['document_id', 'chunk_index']).doUpdateSet((eb) => ({
          content: eb.ref('excluded.content'),
          token_count: eb.ref('excluded.token_count'),
          page_number: eb.ref('excluded.page_number'),
          section_path: eb.ref('excluded.section_path'),
          char_start: eb.ref('excluded.char_start'),
          char_end: eb.ref('excluded.char_end'),
        })),
      )
      .returningAll()
      .execute();

    // Returned in index order regardless of what Postgres emits, so the caller
    // can pair chunks to embeddings positionally without re-sorting.
    return rows.map(toStoredChunk).sort((left, right) => left.chunkIndex - right.chunkIndex);
  },

  /**
   * Removes chunks at or beyond an index.
   *
   * The other half of convergence. An edited parser, a tuned `CHUNK_SIZE`, or
   * a document re-ingested after a fix can produce *fewer* chunks than before;
   * without this, the surplus rows from the previous run survive, keep their
   * vectors, and are retrieved as passages that are no longer in the document.
   */
  async deleteFromIndex(
    documentId: string,
    fromIndex: number,
    executor: Executor = db,
  ): Promise<number> {
    const result = await executor
      .deleteFrom('document_chunks')
      .where('document_id', '=', documentId)
      .where('chunk_index', '>=', fromIndex)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  },

  /**
   * Chunks still awaiting a vector.
   *
   * The resume query. A job that died after embedding 300 of 500 chunks
   * restarts by asking this question rather than by re-embedding everything —
   * which is what makes partial recovery cost the remainder instead of the
   * whole document, and matters because embedding is the one step that costs
   * real money (docs/06-roadmap.md R3).
   */
  async findUnembedded(
    documentId: string,
    executor: Executor = db,
  ): Promise<StoredChunk[]> {
    const rows = await executor
      .selectFrom('document_chunks')
      .selectAll()
      .where('document_id', '=', documentId)
      .where('vector_id', 'is', null)
      .orderBy('chunk_index')
      .execute();

    return rows.map(toStoredChunk);
  },

  /** Every chunk of a document, in order. */
  async findByDocument(documentId: string, executor: Executor = db): Promise<StoredChunk[]> {
    const rows = await executor
      .selectFrom('document_chunks')
      .selectAll()
      .where('document_id', '=', documentId)
      .orderBy('chunk_index')
      .execute();

    return rows.map(toStoredChunk);
  },

  /**
   * Records that a set of chunks now has vectors.
   *
   * Written **after** the vector store confirms the upsert, never before. The
   * ordering is the whole design: a crash between the two leaves
   * `vector_id IS NULL` on chunks whose vectors do exist, and the retry
   * re-upserts them under the same deterministic id — a wasted embedding call,
   * but no duplicate and no missing vector. The reverse order would mark
   * chunks embedded whose vectors were never written, and those chunks would
   * be permanently absent from the index while the document reported `ready`.
   */
  async markEmbedded(
    entries: { chunkId: string; vectorId: string }[],
    executor: Executor = db,
  ): Promise<number> {
    if (entries.length === 0) return 0;

    /*
      One UPDATE against a VALUES list rather than one per chunk. With batches
      of ~96 the difference is 96 round trips versus 1, inside a job that is
      holding a lease the whole time.
    */
    const pairs = sql.join(
      entries.map((entry) => sql`(${entry.chunkId}::uuid, ${entry.vectorId}::text)`),
    );

    const result = await sql<{ id: string }>`
      UPDATE document_chunks AS c
      SET vector_id = v.vector_id
      FROM (VALUES ${pairs}) AS v(id, vector_id)
      WHERE c.id = v.id
      RETURNING c.id
    `.execute(executor);

    return result.rows.length;
  },

  /** How many chunks a document has — what `documents.chunk_count` records. */
  async countByDocument(documentId: string, executor: Executor = db): Promise<number> {
    const row = await executor
      .selectFrom('document_chunks')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('document_id', '=', documentId)
      .executeTakeFirstOrThrow();

    return row.count;
  },

  /**
   * Lexical search over `content_tsv` — the BM25 half of hybrid retrieval
   * (docs/05-rag-and-chat.md §3.2: "Postgres full-text over `content_tsv`,
   * ranked with `ts_rank_cd`, `k=20`, scoped by `user_id`").
   *
   * Three choices in the SQL below are load-bearing:
   *
   * **`websearch_to_tsquery`, not `to_tsquery`.** `to_tsquery` throws a syntax
   * error on ordinary user input — an unbalanced quote, a bare `&`, the word
   * "and" — which would turn a normal question into a 500. `websearch_to_tsquery`
   * accepts anything, and additionally gives the user quoted phrases, `OR`, and
   * `-exclusion` for free.
   *
   * **`'english'`, matching the generated column.** `content_tsv` is
   * `to_tsvector('english', content)`. A query parsed with a different
   * configuration stems differently — "terminating" would not match
   * "termination" — and the failure is silent: fewer results, no error.
   *
   * **`ts_rank_cd`, not `ts_rank`.** The cover-density variant accounts for how
   * close the matched terms are to each other, so a chunk that contains
   * "notice" and "period" adjacently outranks one that mentions them in
   * unrelated sentences. That is the ranking §3.2 names.
   *
   * The join to `documents` is what makes this one round trip instead of two:
   * the caller needs the document title for the citation, and a second query
   * to fetch it would sit in the hot path of the most latency-sensitive
   * operation in the product.
   */
  async searchLexical(
    input: {
      userId: string;
      query: string;
      limit: number;
      documentIds?: string[] | undefined;
    },
    executor: Executor = db,
  ): Promise<LexicalHit[]> {
    /*
      An empty filter list means "no documents", not "all documents".

      Answered here rather than in SQL because `IN ()` is a syntax error and
      `= ANY('{}')` matches nothing — both correct, neither obvious. Returning
      early makes the intent explicit and saves a round trip.
    */
    if (input.documentIds?.length === 0) return [];

    const documentFilter =
      input.documentIds === undefined
        ? sql`TRUE`
        : sql`c.document_id = ANY(${sql.val(input.documentIds)}::uuid[])`;

    const result = await sql<LexicalRow>`
      SELECT
        c.id,
        c.document_id,
        c.chunk_index,
        c.content,
        c.token_count,
        c.page_number,
        c.section_path,
        d.filename AS document_title,
        ts_rank_cd(c.content_tsv, q.query) AS rank
      FROM document_chunks AS c
      JOIN documents AS d ON d.id = c.document_id
      CROSS JOIN websearch_to_tsquery('english', ${input.query}) AS q(query)
      WHERE c.user_id = ${input.userId}
        AND c.content_tsv @@ q.query
        AND ${documentFilter}
      ORDER BY rank DESC, c.id ASC
      LIMIT ${input.limit}
    `.execute(executor);

    return result.rows.map((row) => ({
      chunkId: row.id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      text: row.content,
      chunkIndex: row.chunk_index,
      tokenCount: row.token_count,
      pageNumber: row.page_number,
      sectionPath: row.section_path,
      // `ts_rank_cd` comes back as a float4; the driver may hand it over as a
      // string depending on the type parser in force.
      score: Number(row.rank),
    }));
  },

  /**
   * How many chunks a user has indexed, across every document.
   *
   * Read only on the abstention path, to separate "you have uploaded nothing"
   * from "your documents do not answer this" — two states that look identical
   * in an empty result set and call for opposite product responses.
   */
  async countForUser(userId: string, executor: Executor = db): Promise<number> {
    const row = await executor
      .selectFrom('document_chunks')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    return row.count;
  },

  /** Removes every chunk of a document. Used by re-processing, not by delete. */
  async deleteByDocument(documentId: string, executor: Executor = db): Promise<number> {
    const result = await executor
      .deleteFrom('document_chunks')
      .where('document_id', '=', documentId)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  },
};
