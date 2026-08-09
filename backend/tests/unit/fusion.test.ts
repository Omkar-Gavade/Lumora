import { describe, expect, it } from 'vitest';
import { RRF_K } from '@lumora/shared';
import { env } from '../../src/config/index.js';
import {
  applyRelevanceFloor,
  capPerDocument,
  reciprocalRankFusion,
  type FusedChunk,
  type RankedList,
} from '../../src/services/retrieval/fusion.js';
import {
  dedupeByChunkId,
  rankDeterministically,
  type RetrievedChunk,
} from '../../src/services/retrieval/retriever.interface.js';
import { NoopReranker } from '../../src/services/retrieval/reranker.js';

function chunk(overrides: Partial<RetrievedChunk> & { chunkId: string }): RetrievedChunk {
  return {
    documentId: 'doc-1',
    documentTitle: 'agreement.pdf',
    text: 'passage text',
    chunkIndex: 0,
    tokenCount: 100,
    pageNumber: 1,
    sectionPath: null,
    score: 0.5,
    ...overrides,
  };
}

/** A ranked list from `chunkId`s, in the order given. */
function list(source: 'vector' | 'bm25', ids: string[]): RankedList {
  return {
    source,
    chunks: ids.map((chunkId, index) => chunk({ chunkId, score: 1 - index * 0.01 })),
  };
}

describe('reciprocalRankFusion', () => {
  it('scores each chunk as the documented sum of reciprocal ranks', () => {
    // docs/05-rag-and-chat.md §3.2: `score = Σ 1 / (60 + rank_i)`.
    const fused = reciprocalRankFusion([list('vector', ['a', 'b'])]);

    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(fused[1]?.score).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  it('uses 1-based ranks', () => {
    // Rank 0 would make the top result contribute `1/k` rather than
    // `1/(k+1)` — a constant shift that is easy to introduce and hard to spot.
    const fused = reciprocalRankFusion([list('vector', ['a'])]);

    expect(fused[0]?.score).toBeCloseTo(1 / 61, 10);
    expect(fused[0]?.score).not.toBeCloseTo(1 / 60, 10);
  });

  it('adds the contributions of a chunk found by both retrievers', () => {
    const fused = reciprocalRankFusion([list('vector', ['a']), list('bm25', ['a'])]);

    expect(fused).toHaveLength(1);
    expect(fused[0]?.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('ranks agreement above one retriever’s confidence', () => {
    /*
      The behaviour that justifies hybrid search. With k=60 the gap between
      rank 1 and rank 2 is tiny, so a chunk both retrievers rank *second*
      outscores one a single retriever ranks *first* — agreement between two
      independent methods is stronger evidence than one method's certainty.
    */
    const fused = reciprocalRankFusion([
      list('vector', ['solo', 'agreed']),
      list('bm25', ['other', 'agreed']),
    ]);

    expect(fused[0]?.chunkId).toBe('agreed');
    expect(fused[0]?.source).toBe('hybrid');
  });

  it('never sums the retrievers’ own scores', () => {
    /*
      §3.2 chose RRF because "cosine similarity and `ts_rank_cd` are on
      incomparable, non-normalized scales". A lexical score of 0.0001 next to a
      cosine of 0.9 must not move the ranking — only rank does.
    */
    const vector: RankedList = { source: 'vector', chunks: [chunk({ chunkId: 'a', score: 0.9 })] };
    const lexical: RankedList = {
      source: 'bm25',
      chunks: [chunk({ chunkId: 'b', score: 0.0001 })],
    };

    const fused = reciprocalRankFusion([vector, lexical]);

    // Both ranked 1st by their own retriever, so both score identically.
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? 0, 10);
  });

  it('deduplicates: one entry per chunk id', () => {
    const fused = reciprocalRankFusion([
      list('vector', ['a', 'b', 'c']),
      list('bm25', ['c', 'b', 'a']),
    ]);

    expect(fused).toHaveLength(3);
    expect(new Set(fused.map((entry) => entry.chunkId)).size).toBe(3);
  });

  it('labels the source each chunk came from', () => {
    const fused = reciprocalRankFusion([
      list('vector', ['only-vector', 'both']),
      list('bm25', ['only-lexical', 'both']),
    ]);

    const bySource = new Map(fused.map((entry) => [entry.chunkId, entry.source]));

    // The single most useful debugging signal in the pipeline: a result set
    // that is entirely `vector` on an identifier query says the lexical half
    // is not working.
    expect(bySource.get('only-vector')).toBe('vector');
    expect(bySource.get('only-lexical')).toBe('bm25');
    expect(bySource.get('both')).toBe('hybrid');
  });

  it('records each retriever’s rank and score for debugging', () => {
    const vector: RankedList = {
      source: 'vector',
      chunks: [chunk({ chunkId: 'x', score: 0.83 }), chunk({ chunkId: 'y' })],
    };
    const lexical: RankedList = { source: 'bm25', chunks: [chunk({ chunkId: 'x', score: 0.04 })] };

    const [top] = reciprocalRankFusion([vector, lexical]);

    expect(top).toMatchObject({
      chunkId: 'x',
      vectorRank: 1,
      vectorScore: 0.83,
      lexicalRank: 1,
      lexicalScore: 0.04,
    });
  });

  it('leaves the other retriever’s rank null when only one found the chunk', () => {
    const [only] = reciprocalRankFusion([list('vector', ['a'])]);

    expect(only?.lexicalRank).toBeNull();
    expect(only?.lexicalScore).toBeNull();
  });

  it('is deterministic — identical input, identical output', () => {
    const build = (): RankedList[] => [
      list('vector', ['a', 'b', 'c']),
      list('bm25', ['d', 'b', 'e']),
    ];

    const first = reciprocalRankFusion(build());
    const second = reciprocalRankFusion(build());

    expect(second.map((entry) => entry.chunkId)).toEqual(first.map((entry) => entry.chunkId));
  });

  it('breaks ties on chunk id rather than on arrival order', () => {
    /*
      Two chunks each ranked 1st by one retriever score identically. Without a
      deterministic tiebreak, their order depends on which retriever's promise
      settled first — so the same query could return a different top result on
      a slow day.
    */
    const forward = reciprocalRankFusion([list('vector', ['zebra']), list('bm25', ['alpha'])]);
    const reversed = reciprocalRankFusion([list('bm25', ['alpha']), list('vector', ['zebra'])]);

    expect(forward[0]?.chunkId).toBe('alpha');
    expect(reversed.map((entry) => entry.chunkId)).toEqual(
      forward.map((entry) => entry.chunkId),
    );
  });

  it('honours a configured fusion constant', () => {
    const fused = reciprocalRankFusion([list('vector', ['a'])], 10);

    expect(fused[0]?.score).toBeCloseTo(1 / 11, 10);
  });

  it('returns nothing for an empty corpus', () => {
    expect(reciprocalRankFusion([list('vector', []), list('bm25', [])])).toEqual([]);
  });

  it('works when one retriever returned nothing', () => {
    // Degrading to a single half must still produce a usable ranking.
    const fused = reciprocalRankFusion([list('vector', ['a', 'b']), list('bm25', [])]);

    expect(fused.map((entry) => entry.chunkId)).toEqual(['a', 'b']);
    expect(fused.every((entry) => entry.source === 'vector')).toBe(true);
  });
});

describe('applyRelevanceFloor', () => {
  const fused = (overrides: Partial<FusedChunk> & { chunkId: string }): FusedChunk => ({
    ...chunk({ chunkId: overrides.chunkId }),
    score: 0.016,
    source: 'vector',
    vectorRank: 1,
    vectorScore: 0.5,
    lexicalRank: null,
    lexicalScore: null,
    ...overrides,
  });

  it('discards a chunk below the floor regardless of its rank', () => {
    /*
      §3.3: "Rank is relative; a top-ranked chunk in a corpus containing
      nothing relevant is still irrelevant, and this is exactly how naive RAG
      hallucinates: it always returns *something*."
    */
    const kept = applyRelevanceFloor(
      [fused({ chunkId: 'weak', vectorScore: 0.1 }), fused({ chunkId: 'strong', vectorScore: 0.8 })],
      0.3,
    );

    expect(kept.map((entry) => entry.chunkId)).toEqual(['strong']);
  });

  it('keeps a chunk exactly at the floor', () => {
    expect(applyRelevanceFloor([fused({ chunkId: 'a', vectorScore: 0.3 })], 0.3)).toHaveLength(1);
  });

  it('keeps a lexical-only hit, which has no semantic score', () => {
    /*
      The interpretation stated in the implementation. Discarding these would
      destroy the exact case §3.2 says hybrid search exists for — "exact
      identifiers, product codes… tokens where a dense vector has learned
      little" — because those are precisely the chunks the vector half misses.
    */
    const kept = applyRelevanceFloor(
      [fused({ chunkId: 'code', source: 'bm25', vectorScore: null, lexicalScore: 0.02 })],
      0.9,
    );

    expect(kept).toHaveLength(1);
  });

  it('empties the set when nothing clears the floor — the abstention case', () => {
    const kept = applyRelevanceFloor(
      [fused({ chunkId: 'a', vectorScore: 0.05 }), fused({ chunkId: 'b', vectorScore: 0.02 })],
      0.5,
    );

    expect(kept).toEqual([]);
  });

  it('passes everything through only at -1, the disabling value', () => {
    /*
      Cosine similarity ranges over [-1, 1], so **-1 is the only value that
      disables the floor**. Zero looks like a neutral "off" and is not: it
      discards every chunk whose similarity is negative, which is a real
      threshold nobody chose. The shipped default is -1 for exactly this
      reason, and this test exists because `0` is the value someone tidying
      the config would reach for.
    */
    const chunks = [
      fused({ chunkId: 'negative', vectorScore: -0.4 }),
      fused({ chunkId: 'zero', vectorScore: 0 }),
      fused({ chunkId: 'positive', vectorScore: 0.9 }),
    ];

    expect(applyRelevanceFloor(chunks, -1)).toHaveLength(3);
    // The contrast that makes the point: 0 is not "off".
    expect(applyRelevanceFloor(chunks, 0)).toHaveLength(2);
  });

  it('ships disabled by default', () => {
    // Asserted against the config rather than restated, so a change to the
    // default has to come here and justify itself.
    expect(env.RETRIEVAL_MIN_SCORE).toBe(-1);
  });
});

describe('capPerDocument', () => {
  const fromDocument = (chunkId: string, documentId: string): FusedChunk => ({
    ...chunk({ chunkId, documentId }),
    score: 0.016,
    source: 'vector',
    vectorRank: 1,
    vectorScore: 0.5,
    lexicalRank: null,
    lexicalScore: null,
  });

  it('caps how many chunks one document contributes', () => {
    /*
      §3.3: "so one long, verbose document cannot monopolize the context and
      starve a more relevant passage in another file". A fifty-page manual
      always has more near-misses than a two-page memo.
    */
    const capped = capPerDocument(
      [
        fromDocument('a1', 'big'),
        fromDocument('a2', 'big'),
        fromDocument('a3', 'big'),
        fromDocument('a4', 'big'),
        fromDocument('b1', 'small'),
      ],
      3,
    );

    expect(capped.map((entry) => entry.chunkId)).toEqual(['a1', 'a2', 'a3', 'b1']);
  });

  it('keeps a document’s best chunks, not an arbitrary three', () => {
    // Input order is the ranking, so the cap must preserve it.
    const capped = capPerDocument(
      ['a1', 'a2', 'a3', 'a4'].map((id) => fromDocument(id, 'doc')),
      2,
    );

    expect(capped.map((entry) => entry.chunkId)).toEqual(['a1', 'a2']);
  });

  it('does not cap across different documents', () => {
    const capped = capPerDocument(
      [fromDocument('a', 'one'), fromDocument('b', 'two'), fromDocument('c', 'three')],
      1,
    );

    expect(capped).toHaveLength(3);
  });

  it('handles an empty list', () => {
    expect(capPerDocument([], 3)).toEqual([]);
  });
});

describe('rankDeterministically', () => {
  it('orders by score descending', () => {
    const ranked = rankDeterministically([
      chunk({ chunkId: 'low', score: 0.1 }),
      chunk({ chunkId: 'high', score: 0.9 }),
    ]);

    expect(ranked.map((entry) => entry.chunkId)).toEqual(['high', 'low']);
  });

  it('breaks equal scores on chunk id, so ties never reorder between runs', () => {
    // Neither Chroma nor Postgres promises a stable order for equal scores,
    // and an unstable tie changes ranks, which changes RRF scores.
    const shuffled = rankDeterministically([
      chunk({ chunkId: 'c', score: 0.5 }),
      chunk({ chunkId: 'a', score: 0.5 }),
      chunk({ chunkId: 'b', score: 0.5 }),
    ]);

    expect(shuffled.map((entry) => entry.chunkId)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate its input', () => {
    const input = [chunk({ chunkId: 'b', score: 0.1 }), chunk({ chunkId: 'a', score: 0.9 })];
    rankDeterministically(input);

    expect(input[0]?.chunkId).toBe('b');
  });
});

describe('dedupeByChunkId', () => {
  it('keeps the best-scoring occurrence', () => {
    const deduped = dedupeByChunkId([
      chunk({ chunkId: 'a', score: 0.2 }),
      chunk({ chunkId: 'a', score: 0.8 }),
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.score).toBe(0.8);
  });

  it('leaves distinct chunks alone', () => {
    expect(dedupeByChunkId([chunk({ chunkId: 'a' }), chunk({ chunkId: 'b' })])).toHaveLength(2);
  });
});

describe('NoopReranker', () => {
  it('returns the fused order untouched', async () => {
    /*
      §3.4 requires "an explicit no-op `Reranker` stage so adding one later is
      registering an implementation, not restructuring retrieval". The property
      that matters is that the stage exists and is order-preserving today.
    */
    const candidates = reciprocalRankFusion([list('vector', ['a', 'b', 'c'])]);

    const reranked = await new NoopReranker().rerank('a question', candidates);

    expect(reranked).toEqual(candidates);
  });
});
