import { sql } from 'kysely';
import { db } from '../../db/pool.js';
import {
  VectorStoreError,
  type MetadataFilter,
  type VectorMatch,
  type VectorRecord,
  type VectorStore,
} from './vector-store.interface.js';

/**
 * The production vector store (docs/08-production-architecture.md §6).
 *
 * One table in the application database rather than a second service. The
 * `VectorStore` interface is unchanged, so retrieval does not know which
 * backend it is talking to — which is the whole reason that interface exists
 * (§8, the seam) and why this swap is a re-index rather than a data migration.
 *
 * **A collection is a column here, not a schema object.** Chroma's per-user
 * collections gave tenant isolation structurally; in one shared table that
 * becomes a predicate, so every statement below filters on `collection` and
 * the caller-supplied name is the only thing that decides which tenant's rows
 * are visible. `collectionFor()` is the single place that name is built, and
 * `user_id` is stored redundantly as a second, independent filter.
 */
export class PgVectorStore implements VectorStore {
  readonly name = 'pgvector';

  /**
   * Writes records, overwriting any that already exist.
   *
   * `ON CONFLICT (collection, id) DO UPDATE` is the upsert the pipeline
   * depends on: every retry re-issues vectors it already wrote, and an
   * append-only store would multiply them per attempt. Ids are deterministic
   * (`{documentId}:{chunkIndex}`), so "the same chunk" is the same row.
   *
   * One statement for the whole batch. A row-at-a-time loop over ninety-six
   * embeddings is ninety-six round trips inside a job that already holds a
   * lease.
   */
  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    try {
      const values = records.map(
        (record) => sql`(
          ${collection},
          ${record.id},
          ${toVectorLiteral(record.embedding)}::vector,
          ${record.text},
          ${record.metadata.chunkId}::uuid,
          ${record.metadata.documentId}::uuid,
          ${record.metadata.userId}::uuid,
          ${record.metadata.documentName},
          ${record.metadata.chunkIndex},
          ${record.metadata.pageNumber},
          ${record.metadata.sectionPath}
        )`,
      );

      await sql`
        INSERT INTO document_vectors (
          collection, id, embedding, text,
          chunk_id, document_id, user_id, document_name,
          chunk_index, page_number, section_path
        )
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (collection, id) DO UPDATE SET
          embedding     = EXCLUDED.embedding,
          text          = EXCLUDED.text,
          chunk_id      = EXCLUDED.chunk_id,
          document_id   = EXCLUDED.document_id,
          user_id       = EXCLUDED.user_id,
          document_name = EXCLUDED.document_name,
          chunk_index   = EXCLUDED.chunk_index,
          page_number   = EXCLUDED.page_number,
          section_path  = EXCLUDED.section_path
      `.execute(db);
    } catch (error) {
      throw new VectorStoreError(this.name, `upsert failed: ${describe(error)}`, true, error);
    }
  }

  /**
   * Nearest neighbours within one collection.
   *
   * `<=>` is cosine distance, so `1 - distance` is the similarity the rest of
   * the pipeline compares against — identical to what the Chroma adapter
   * returns, because the relevance floor and the fusion ranking are expressed
   * in that space and a store that returned raw distance would silently invert
   * "higher is better".
   */
  async query(
    collection: string,
    embedding: number[],
    k: number,
    filter?: MetadataFilter,
  ): Promise<VectorMatch[]> {
    /*
      An empty `$in` matches nothing, and must not be allowed to become an
      absent predicate. This is the same distinction the retrieval layer makes
      between "unscoped" and "scoped to nothing" (docs/07 §6.3): a
      conversation scoped to an empty Knowledge Base has to retrieve nothing,
      not everything the tenant owns.
    */
    const predicate = buildFilter(filter);
    if (predicate === IMPOSSIBLE) return [];

    try {
      const vector = toVectorLiteral(embedding);

      const result = await sql<VectorRow & { distance: number }>`
        SELECT
          id, text, chunk_id, document_id, user_id, document_name,
          chunk_index, page_number, section_path,
          embedding <=> ${vector}::vector AS distance
        FROM document_vectors
        WHERE collection = ${collection}
          AND ${predicate}
        ORDER BY embedding <=> ${vector}::vector
        LIMIT ${k}
      `.execute(db);

      return result.rows.map((row) => ({
        id: row.id,
        score: 1 - row.distance,
        text: row.text,
        metadata: toMetadata(row),
      }));
    } catch (error) {
      throw new VectorStoreError(this.name, `query failed: ${describe(error)}`, true, error);
    }
  }

  /**
   * Removes every vector belonging to one document.
   *
   * A real delete, matching the rest of the product (docs/04 §1.2: no soft
   * deletes). A document removed from Postgres but left in the index keeps
   * appearing in answers, which breaks the privacy promise in a way the user
   * cannot see.
   */
  async deleteByDocument(collection: string, documentId: string): Promise<void> {
    try {
      await sql`
        DELETE FROM document_vectors
         WHERE collection = ${collection}
           AND document_id = ${documentId}::uuid
      `.execute(db);
    } catch (error) {
      throw new VectorStoreError(
        this.name,
        `deleteByDocument failed: ${describe(error)}`,
        true,
        error,
      );
    }
  }

  /** Drops a whole collection — account deletion, or a full re-index. */
  async deleteCollection(collection: string): Promise<void> {
    try {
      await sql`DELETE FROM document_vectors WHERE collection = ${collection}`.execute(db);
    } catch (error) {
      throw new VectorStoreError(
        this.name,
        `deleteCollection failed: ${describe(error)}`,
        true,
        error,
      );
    }
  }

  /**
   * Reachability.
   *
   * Checks the extension rather than just the connection: a database that is
   * up but has no `vector` extension answers every query with a syntax error,
   * and startup should say that rather than "healthy".
   */
  async health(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const startedAt = Date.now();

    try {
      const result = await sql<{ installed: string | null }>`
        SELECT installed_version AS installed
          FROM pg_available_extensions
         WHERE name = 'vector'
      `.execute(db);

      const installed = result.rows[0]?.installed ?? null;
      if (installed === null) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          message: 'the `vector` extension is not installed — run migrations',
        };
      }

      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: describe(error),
      };
    }
  }
}

interface VectorRow {
  id: string;
  text: string;
  chunk_id: string;
  document_id: string;
  user_id: string;
  document_name: string;
  chunk_index: number;
  page_number: number | null;
  section_path: string | null;
}

function toMetadata(row: VectorRow) {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    userId: row.user_id,
    documentName: row.document_name,
    chunkIndex: row.chunk_index,
    pageNumber: row.page_number,
    sectionPath: row.section_path,
  };
}

/** Sentinel for a filter that cannot match, distinct from having no filter. */
const IMPOSSIBLE = Symbol('impossible-filter');

/**
 * Translates a `MetadataFilter` into SQL.
 *
 * Only the two operators the interface defines — equality and `$in` — and
 * only over known columns. **The key is never interpolated**: an unknown key
 * raises rather than reaching the query, so the filter can never become an
 * injection vector even though it arrives as a string-keyed object.
 */
function buildFilter(filter: MetadataFilter | undefined) {
  if (filter === undefined) return sql`TRUE`;

  const clauses = [];

  for (const [key, value] of Object.entries(filter)) {
    const column = FILTERABLE_COLUMNS[key];
    if (column === undefined) {
      throw new VectorStoreError('pgvector', `filter on unsupported field "${key}"`, false);
    }

    if (typeof value === 'object' && value !== null && '$in' in value) {
      if (value.$in.length === 0) return IMPOSSIBLE;
      clauses.push(sql`${column} = ANY(${sql.val(value.$in)}::uuid[])`);
      continue;
    }

    clauses.push(sql`${column} = ${String(value)}::uuid`);
  }

  return clauses.length === 0 ? sql`TRUE` : sql.join(clauses, sql` AND `);
}

/**
 * The metadata fields that may be filtered, mapped to their columns.
 *
 * An allowlist rather than a passthrough. Retrieval filters by document today
 * (docs/07 §6) and by user as a defence in depth; anything else is a caller
 * mistake worth failing loudly rather than a query worth building.
 */
const FILTERABLE_COLUMNS: Record<string, ReturnType<typeof sql.ref> | undefined> = {
  documentId: sql.ref('document_id'),
  userId: sql.ref('user_id'),
  chunkId: sql.ref('chunk_id'),
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `[1, 2, 3]` → `'[1,2,3]'`, which is pgvector's input format.
 *
 * Built as a bound parameter rather than spliced into the statement, so a
 * malformed embedding is a type error at the database rather than a fragment
 * of SQL.
 */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
