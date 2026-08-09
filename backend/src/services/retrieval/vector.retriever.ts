import { env } from '../../config/index.js';
import type { EmbeddingProvider } from '../../providers/embedding/embedding-provider.interface.js';
import { collectionFor } from '../../providers/vector/vector-store.interface.js';
import type { VectorStore } from '../../providers/vector/vector-store.interface.js';
import { estimateTokens } from '../documents/parsing/normalize.js';
import {
  dedupeByChunkId,
  rankDeterministically,
  type RetrievalQuery,
  type RetrievedChunk,
  type Retriever,
} from './retriever.interface.js';

/**
 * Semantic retrieval through the `VectorStore` abstraction
 * (docs/05-rag-and-chat.md §3.2: "embed the rewritten query, `k=20` from the
 * user's collection").
 *
 * **No database calls.** Every field a citation needs was written into the
 * vector's metadata at index time, which is the entire reason §2.5 specifies
 * that metadata list: "enough for the UI to render a citation without a second
 * database round trip on the hot path". Hydrating twenty chunks from Postgres
 * here would undo that decision on the one path it was made for.
 *
 * The store is injected rather than imported, so a second backend — pgvector,
 * Qdrant — is a constructor argument and not a change to retrieval logic
 * (§8, the `VectorStore` seam).
 */
export class VectorRetriever implements Retriever {
  readonly name = 'vector';

  constructor(
    private readonly store: VectorStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly collectionPrefix: string = env.CHROMA_COLLECTION_PREFIX,
  ) {}

  async retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    /*
      `embedQuery`, never `embed`.

      §6: several embedding models are trained asymmetrically with distinct
      query and document prefixes, and "using the document form for queries
      silently costs recall". The two methods exist on the interface precisely
      so this call site cannot get it wrong by convenience.
    */
    const embedding = await this.embeddings.embedQuery(query.text);

    /*
      Document filtering is pushed into the store rather than applied after.

      Filtering `k=20` results down to the two that came from the requested
      document would return two chunks where the caller asked for twenty — the
      filter has to be part of the search, not a post-condition on it.

      A single-document filter goes through the store's metadata filter. A
      multi-document one is applied here, because the `MetadataFilter` contract
      is equality-only and inventing an `$in` operator would change a
      documented interface for one call site.
    */
    const singleDocument =
      query.documentIds?.length === 1 ? query.documentIds[0] : undefined;

    const matches = await this.store.query(
      collectionFor(query.userId, this.collectionPrefix),
      embedding,
      // Over-fetch when filtering client-side, so a multi-document filter does
      // not silently return fewer than `topK` results that exist.
      this.needsClientFilter(query) ? query.topK * OVERFETCH_FACTOR : query.topK,
      singleDocument === undefined ? undefined : { documentId: singleDocument },
    );

    const wanted = new Set(query.documentIds ?? []);

    const chunks: RetrievedChunk[] = matches
      .filter((match) => wanted.size === 0 || wanted.has(match.metadata.documentId))
      .map((match) => ({
        chunkId: match.metadata.chunkId,
        documentId: match.metadata.documentId,
        documentTitle: match.metadata.documentName,
        text: match.text,
        chunkIndex: match.metadata.chunkIndex,
        // Recomputed rather than stored on the vector: the estimate is a pure
        // function of the text, and a second copy in metadata is a second
        // thing that can disagree with the chunk row.
        tokenCount: estimateTokens(match.text),
        pageNumber: match.metadata.pageNumber,
        sectionPath: match.metadata.sectionPath,
        score: match.score,
      }));

    return rankDeterministically(dedupeByChunkId(chunks)).slice(0, query.topK);
  }

  /** True when the filter cannot be expressed as a single equality. */
  private needsClientFilter(query: RetrievalQuery): boolean {
    return (query.documentIds?.length ?? 0) > 1;
  }
}

/**
 * How much to over-fetch when a filter is applied after the search.
 *
 * Four is a compromise, and an honest one: there is no value that guarantees
 * `topK` survivors, because the store cannot say how the filtered documents
 * are distributed through the ranking. Four covers the realistic case — a
 * filter over a handful of documents in a corpus of dozens — without asking a
 * vector index for eighty neighbours to return six.
 */
const OVERFETCH_FACTOR = 4;
