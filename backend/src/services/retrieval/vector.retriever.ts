import { env } from '../../config/index.js';
import type { EmbeddingProvider } from '../../providers/embedding/embedding-provider.interface.js';
import { collectionFor } from '../../providers/vector/vector-store.interface.js';
import type { MetadataFilter, VectorStore } from '../../providers/vector/vector-store.interface.js';
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

    const filter = documentFilter(query.documentIds);

    /*
      An empty scope short-circuits, and does not reach the store.

      This is the correction docs/07-knowledge-base.md §6.3 (D-1) requires. The
      lexical half has always read an empty list as "no documents"; this half
      read it as "no filter" and returned the user's entire corpus. A
      conversation scoped to an empty Knowledge Base would therefore have been
      answered from documents it was never scoped to — not a cross-tenant leak,
      since the collection is still per-user, but a scope the user did not
      choose, presented as though they had.
    */
    if (filter === EMPTY_SCOPE) return [];

    const matches = await this.store.query(
      collectionFor(query.userId, this.collectionPrefix),
      embedding,
      /*
        `topK`, not `topK × 4`.

        The filter is now applied inside the search for every case — one
        document by equality, many by `$in` — so the store returns `topK`
        matching neighbours rather than `topK` neighbours of which some match.
        The over-fetch existed only to compensate for filtering afterwards, and
        it never guaranteed enough survivors.
      */
      query.topK,
      filter,
    );

    const chunks: RetrievedChunk[] = matches
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
}

/**
 * Sentinel for "scoped to nothing", which is distinct from "not scoped".
 *
 * A separate value rather than `null`, because the three states this function
 * returns are genuinely three — no filter, an impossible filter, and a real
 * filter — and collapsing the first two is exactly the bug being fixed.
 */
const EMPTY_SCOPE = Symbol('empty-scope');

/**
 * The store filter for a document scope.
 *
 *   `undefined`   → no filter; the user's whole corpus (unchanged behaviour)
 *   `[]`          → EMPTY_SCOPE; nothing can match
 *   `[one]`       → equality
 *   `[many]`      → `$in`, evaluated inside the store
 *
 * The distinction between the first two is load-bearing and easy to destroy by
 * defaulting one into the other, which is why it is resolved here once instead
 * of at each call site.
 */
function documentFilter(
  documentIds: string[] | undefined,
): MetadataFilter | undefined | typeof EMPTY_SCOPE {
  if (documentIds === undefined) return undefined;
  if (documentIds.length === 0) return EMPTY_SCOPE;

  const [only] = documentIds;
  if (documentIds.length === 1 && only !== undefined) return { documentId: only };

  return { documentId: { $in: documentIds } };
}
