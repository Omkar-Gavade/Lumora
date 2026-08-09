import { chunkRepository } from '../../repositories/chunk.repository.js';
import {
  dedupeByChunkId,
  rankDeterministically,
  type RetrievalQuery,
  type RetrievedChunk,
  type Retriever,
} from './retriever.interface.js';

/**
 * Lexical retrieval over Postgres full-text search
 * (docs/05-rag-and-chat.md §3.2).
 *
 * **Why this half exists at all.** §3.2: "Embeddings fail precisely where users
 * are most confident: exact identifiers, product codes, uncommon proper nouns,
 * acronyms, section numbers, and rare technical terms — tokens where a dense
 * vector has learned little." A query for `ACME-1200/B` is a query where the
 * semantic half has nothing useful to say, and this half answers it exactly.
 *
 * Completely independent of the vector retriever: no shared state, no shared
 * query preparation beyond normalization, and no knowledge that a vector store
 * exists. That independence is what lets either half be replaced, disabled, or
 * debugged without touching the other — and it is why "the answer is wrong"
 * can be attributed to one of them.
 *
 * The SQL, its query parser, and its ranking function all live in
 * `chunkRepository.searchLexical`, because docs/03-backend.md §1 puts SQL in
 * repositories and this service owns no queries of its own.
 */
export class Bm25Retriever implements Retriever {
  readonly name = 'bm25';

  async retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    /*
      A query with no searchable terms is answered without a round trip.

      `websearch_to_tsquery` on a string of pure punctuation produces an empty
      tsquery, which matches nothing — so the database would do real work to
      return zero rows. The vector half still runs, which is correct: a query
      the lexical parser cannot tokenize may still embed to something useful.
    */
    if (!hasSearchableTerm(query.text)) return [];

    const hits = await chunkRepository.searchLexical({
      userId: query.userId,
      query: query.text,
      limit: query.topK,
      documentIds: query.documentIds,
    });

    // The SQL already orders and the join cannot duplicate a chunk, so both
    // passes are cheap no-ops in the normal case. They are here so the
    // interface's guarantees hold for *every* retriever rather than being a
    // property this one happens to have.
    return rankDeterministically(dedupeByChunkId(hits));
  }
}

/**
 * Whether the query contains anything the text-search parser can tokenize.
 *
 * Letters or digits in any script — `\p{L}` and `\p{N}` rather than `\w`, so a
 * query in Greek, Cyrillic, or CJK is not dismissed as unsearchable by a rule
 * that only ever considered ASCII.
 */
function hasSearchableTerm(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
