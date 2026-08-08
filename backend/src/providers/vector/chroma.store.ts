import { ChromaClient, type Collection, type EmbeddingFunction } from 'chromadb';
import {
  VectorStoreError,
  type MetadataFilter,
  type VectorMatch,
  type VectorMetadata,
  type VectorRecord,
  type VectorStore,
} from './vector-store.interface.js';

/**
 * Chroma metadata values must be scalars — no `null`, no nested objects.
 *
 * `pageNumber` and `sectionPath` are genuinely nullable (an unpaginated DOCX,
 * a paragraph outside any heading), so they are **omitted** rather than sent as
 * `null`, and read back as `null` when absent. Sending `null` is accepted by
 * some Chroma versions and rejected by others; omission is correct in all of
 * them.
 */
type ChromaMetadata = Record<string, string | number | boolean>;

/**
 * Tells the client not to supply an embedding function.
 *
 * `getOrCreateCollection` accepts `null` in its own types; `getCollection` does
 * not, even though the runtime treats both identically. The cast is confined to
 * this one constant so the reason lives in one place rather than at three call
 * sites — and so a client release that fixes the typing is a one-line deletion.
 *
 * Passing nothing is not equivalent: the client would fall back to its default
 * embedder and try to load a local model, putting a second, undeclared model in
 * charge of half the index.
 */
const NO_EMBEDDING_FUNCTION = null as unknown as EmbeddingFunction;

/**
 * ChromaDB, behind `VectorStore` (docs/05-rag-and-chat.md §2.5).
 *
 * Vectors are always supplied by the caller — the collection is created with
 * no embedding function, so Chroma never downloads a model or embeds anything
 * itself. That keeps one component responsible for embeddings (the
 * `EmbeddingProvider`) instead of two that could silently disagree about which
 * model produced the index.
 *
 * Collections are created with cosine distance explicitly. Chroma's default is
 * L2, and for normalized embeddings the two rank differently — a default taken
 * by accident is a retrieval-quality decision nobody made.
 */
export class ChromaVectorStore implements VectorStore {
  readonly name = 'chroma';

  private readonly client: ChromaClient;

  /**
   * Collection handles by name.
   *
   * `getOrCreateCollection` is a network round trip, and the ingestion path
   * calls it once per batch. Caching turns per-batch overhead into per-process
   * overhead. Safe because a collection handle is a name and an id, and both
   * are stable for the process's lifetime — `deleteCollection` evicts the
   * entry so a recreated collection is not addressed by a dead id.
   */
  private readonly collections = new Map<string, Promise<Collection>>();

  constructor(url: string) {
    const parsed = new URL(url);

    // `host`/`port`/`ssl` rather than the deprecated `path` option, which the
    // client warns about on every construction.
    this.client = new ChromaClient({
      host: parsed.hostname,
      port: parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port),
      ssl: parsed.protocol === 'https:',
    });
  }

  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    const handle = await this.collectionFor(collection);

    try {
      // `upsert`, not `add`. `add` on an existing id is an error in some
      // versions and a duplicate in others; upsert is the operation the
      // pipeline's retry semantics actually require.
      await handle.upsert({
        ids: records.map((record) => record.id),
        embeddings: records.map((record) => record.embedding),
        documents: records.map((record) => record.text),
        metadatas: records.map((record) => toChromaMetadata(record.metadata)),
      });
    } catch (error) {
      throw new VectorStoreError(this.name, `upsert failed: ${describe(error)}`, true, error);
    }
  }

  async query(
    collection: string,
    embedding: number[],
    k: number,
    filter?: MetadataFilter,
  ): Promise<VectorMatch[]> {
    /*
      Read-only, so it opens the collection rather than creating one. A query
      against a user with no indexed documents is ordinary — the honest answer
      is no matches, not a new empty collection per question asked.
    */
    let handle: Collection;
    try {
      handle = await this.client.getCollection({ name: collection, embeddingFunction: NO_EMBEDDING_FUNCTION });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw new VectorStoreError(this.name, `query failed: ${describe(error)}`, true, error);
    }

    try {
      const result = await handle.query({
        queryEmbeddings: [embedding],
        nResults: k,
        ...(filter === undefined ? {} : { where: filter }),
      });

      const ids = result.ids[0] ?? [];
      const distances = result.distances?.[0] ?? [];
      const documents = result.documents?.[0] ?? [];
      const metadatas = result.metadatas?.[0] ?? [];

      return ids.map((id, position) => ({
        id,
        // Cosine *distance* → similarity. Returning the raw distance would
        // make "higher is better" false for this store and true for the next
        // one, and the relevance floor in M4c compares against a similarity.
        score: 1 - (distances[position] ?? 0),
        text: documents[position] ?? '',
        metadata: fromChromaMetadata(metadatas[position] ?? {}),
      }));
    } catch (error) {
      throw new VectorStoreError(this.name, `query failed: ${describe(error)}`, true, error);
    }
  }

  async deleteByDocument(collection: string, documentId: string): Promise<void> {
    let handle: Collection;
    try {
      /*
        `getCollection`, **not** `getOrCreateCollection`.

        Deleting from a collection that does not exist must not bring it into
        being. Using the get-or-create helper here meant every delete for a user
        who had never finished an ingestion left behind an empty collection —
        invisible in the product, permanent in Chroma, and growing by one per
        deleted document.
      */
      handle = await this.client.getCollection({
        name: collection,
        embeddingFunction: NO_EMBEDDING_FUNCTION,
      });
    } catch (error) {
      /*
        No collection means no vectors to remove, which is the desired end
        state. Deleting a document whose user never completed an ingestion is
        ordinary, and failing it would leave a Postgres row the user cannot
        remove because a cleanup step insists on a collection that was never
        created.
      */
      if (isNotFound(error)) return;
      throw new VectorStoreError(
        this.name,
        `deleteByDocument failed: ${describe(error)}`,
        true,
        error,
      );
    }

    try {
      // Filtered by metadata rather than by id list: the caller would
      // otherwise have to know every chunk index, and after a partial
      // ingestion it does not.
      await handle.delete({ where: { documentId } });
    } catch (error) {
      throw new VectorStoreError(
        this.name,
        `deleteByDocument failed: ${describe(error)}`,
        true,
        error,
      );
    }
  }

  async deleteCollection(collection: string): Promise<void> {
    this.collections.delete(collection);

    try {
      await this.client.deleteCollection({ name: collection });
    } catch (error) {
      // Already absent is success. Chroma reports a missing collection as an
      // error, and treating that as a failure makes deletion non-idempotent.
      if (isNotFound(error)) return;
      throw new VectorStoreError(
        this.name,
        `deleteCollection failed: ${describe(error)}`,
        true,
        error,
      );
    }
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const startedAt = Date.now();

    try {
      await this.client.heartbeat();
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: describe(error) };
    }
  }

  private collectionFor(name: string): Promise<Collection> {
    const cached = this.collections.get(name);
    if (cached) return cached;

    const pending = this.client
      .getOrCreateCollection({
        name,
        // Cosine, explicitly. See the class comment.
        metadata: { 'hnsw:space': 'cosine' },
        // No embedding function: this store never embeds. Passing `null`
        // suppresses the client's default, which would otherwise try to load a
        // local model on first use — putting a second, undeclared model in
        // charge of half the index.
        embeddingFunction: null,
      })
      .catch((error: unknown) => {
        // Evict on failure, so a transient outage during creation does not
        // leave a permanently rejected promise cached for the process's life.
        this.collections.delete(name);
        throw new VectorStoreError(
          this.name,
          `could not open collection "${name}": ${describe(error)}`,
          true,
          error,
        );
      });

    this.collections.set(name, pending);
    return pending;
  }
}

function toChromaMetadata(metadata: VectorMetadata): ChromaMetadata {
  return {
    chunkId: metadata.chunkId,
    documentId: metadata.documentId,
    userId: metadata.userId,
    documentName: metadata.documentName,
    chunkIndex: metadata.chunkIndex,
    // Omitted when null — see the ChromaMetadata comment.
    ...(metadata.pageNumber === null ? {} : { pageNumber: metadata.pageNumber }),
    ...(metadata.sectionPath === null ? {} : { sectionPath: metadata.sectionPath }),
  };
}

function fromChromaMetadata(raw: Record<string, unknown>): VectorMetadata {
  return {
    chunkId: asString(raw.chunkId),
    documentId: asString(raw.documentId),
    userId: asString(raw.userId),
    documentName: asString(raw.documentName),
    chunkIndex: typeof raw.chunkIndex === 'number' ? raw.chunkIndex : 0,
    pageNumber: typeof raw.pageNumber === 'number' ? raw.pageNumber : null,
    sectionPath: typeof raw.sectionPath === 'string' ? raw.sectionPath : null,
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Recognises "this collection is not there".
 *
 * The client's own error class is checked **by name** rather than with
 * `instanceof`. `ChromaNotFoundError` is not part of the package's public
 * exports, so importing it would reach into internals that can move between
 * minor versions; the name is the stable part of the contract.
 *
 * The message check stays as a fallback because Chroma 1.0.0 phrases this as
 * "The requested resource could not be found" — which contains neither "not
 * found" nor "does not exist" as a phrase, and was exactly the wording that
 * made a message-only check wrong.
 */
function isNotFound(error: unknown): boolean {
  if (error instanceof Error && error.name === 'ChromaNotFoundError') return true;

  const message = describe(error).toLowerCase();
  return message.includes('not found') || message.includes('could not be found');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
