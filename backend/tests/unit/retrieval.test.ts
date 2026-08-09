import { describe, expect, it } from 'vitest';
import { CONTEXT_TOKEN_BUDGET } from '@lumora/shared';
import { buildContext } from '../../src/services/retrieval/context.builder.js';
import type { FusedChunk } from '../../src/services/retrieval/fusion.js';
import { normalizeQuery } from '../../src/services/retrieval/query.normalizer.js';

describe('normalizeQuery', () => {
  it('preserves the user’s original wording alongside the normalized form', () => {
    /*
      §3.1: the rewrite "is used **only** for retrieval; the user's original
      wording is what the answering model sees". Both forms travel together so
      the orchestrator never has to reconstruct either.
    */
    const { text, original } = normalizeQuery('  What is the notice period?  ');

    expect(original).toBe('What is the notice period?');
    expect(text).toBe('What is the notice period');
  });

  it('collapses whitespace, including across lines', () => {
    // A pasted multi-line question should embed as one sentence; a query has
    // no paragraph structure worth preserving.
    expect(normalizeQuery('what   is\n\nthe  notice\tperiod').text).toBe(
      'what is the notice period',
    );
  });

  it('folds typographic punctuation to match the normalized corpus', () => {
    /*
      Chunk text went through the same Unicode folding before it was embedded
      and before `content_tsv` was generated. Skipping it here is a silent
      recall loss on exactly the queries users paste from a word processor.
    */
    expect(normalizeQuery('the company’s “notice” period').text).toBe(
      `the company's "notice" period`,
    );
  });

  it('drops a trailing question mark', () => {
    // "…period?" and "…period" must not be two different queries.
    expect(normalizeQuery('what is the notice period?').text).toBe('what is the notice period');
  });

  it('keeps punctuation inside identifiers', () => {
    /*
      The lexical half exists for "exact identifiers, product codes… section
      numbers" (§3.2). Stripping internal punctuation is precisely how a query
      for `ACME-1200/B` stops matching the thing it names.
    */
    expect(normalizeQuery('does ACME-1200/B ship with v2.1.3?').text).toBe(
      'does ACME-1200/B ship with v2.1.3',
    );
  });

  it('does not change meaning', () => {
    // Normalization is explicitly not rewriting (§3.1). Word order, negation,
    // and content words survive untouched.
    const { text } = normalizeQuery('Which clauses do NOT apply to contractors?');

    expect(text).toBe('Which clauses do NOT apply to contractors');
  });

  it('is idempotent', () => {
    const once = normalizeQuery('what   is the notice period?').text;

    expect(normalizeQuery(once).text).toBe(once);
  });

  it('handles a query that is only punctuation', () => {
    expect(normalizeQuery('???').text).toBe('');
  });
});

describe('buildContext', () => {
  function candidate(overrides: Partial<FusedChunk> & { chunkId: string }): FusedChunk {
    return {
      documentId: 'doc-1',
      documentTitle: 'agreement.pdf',
      text: 'The notice period is thirty days.',
      chunkIndex: 0,
      tokenCount: 100,
      pageNumber: 3,
      sectionPath: '3. Termination',
      score: 0.016,
      source: 'hybrid',
      vectorRank: 1,
      vectorScore: 0.82,
      lexicalRank: 2,
      lexicalScore: 0.04,
      ...overrides,
    };
  }

  it('emits every field a citation needs', () => {
    const { chunks } = buildContext([candidate({ chunkId: 'a' })], { maxResults: 6 });

    expect(chunks[0]).toEqual({
      chunkId: 'a',
      documentId: 'doc-1',
      documentTitle: 'agreement.pdf',
      text: 'The notice period is thirty days.',
      pageNumber: 3,
      sectionPath: '3. Termination',
      chunkIndex: 0,
      tokenCount: 100,
      score: 0.016,
      source: 'hybrid',
      vectorRank: 1,
      vectorScore: 0.82,
      lexicalRank: 2,
      lexicalScore: 0.04,
    });
  });

  it('preserves the ranked order', () => {
    const { chunks } = buildContext(
      [candidate({ chunkId: 'first' }), candidate({ chunkId: 'second' })],
      { maxResults: 6 },
    );

    expect(chunks.map((entry) => entry.chunkId)).toEqual(['first', 'second']);
  });

  it('caps at the final K', () => {
    // §3.3: "Final K ≤ 6".
    const many = Array.from({ length: 12 }, (_, index) =>
      candidate({ chunkId: `c${String(index)}` }),
    );

    expect(buildContext(many, { maxResults: 6 }).chunks).toHaveLength(6);
  });

  it('stays inside the documented token budget', () => {
    // §4.1 allocates ≤4000 tokens to retrieved context.
    const heavy = Array.from({ length: 6 }, (_, index) =>
      candidate({ chunkId: `c${String(index)}`, tokenCount: 1_500 }),
    );

    const built = buildContext(heavy, { maxResults: 6 });

    expect(built.tokenCount).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET);
    expect(built.chunks).toHaveLength(2);
    expect(built.droppedForBudget).toBe(4);
  });

  it('drops the lowest-ranked chunks first, never truncating one', () => {
    /*
      §4.1: overflow is handled "by dropping the lowest-ranked chunks first …
      never by truncating mid-chunk, which produces a source that ends
      mid-clause and a citation that points at a fragment."
    */
    const built = buildContext(
      [
        candidate({ chunkId: 'top', tokenCount: 900 }),
        candidate({ chunkId: 'bottom', tokenCount: 900 }),
      ],
      { maxResults: 6, tokenBudget: 1_000 },
    );

    expect(built.chunks.map((entry) => entry.chunkId)).toEqual(['top']);
    // The kept chunk is whole.
    expect(built.chunks[0]?.text).toBe('The notice period is thirty days.');
    expect(built.chunks[0]?.tokenCount).toBe(900);
  });

  it('fills the budget with a smaller chunk rather than stopping at an oversized one', () => {
    /*
      Skipping rather than breaking. Chunks vary in size, and one large passage
      early in the ranking should not starve smaller, still-relevant ones
      behind it.
    */
    const built = buildContext(
      [
        candidate({ chunkId: 'huge', tokenCount: 5_000 }),
        candidate({ chunkId: 'small', tokenCount: 50 }),
      ],
      { maxResults: 6, tokenBudget: 1_000 },
    );

    expect(built.chunks.map((entry) => entry.chunkId)).toEqual(['small']);
  });

  it('reports the budget it enforced', () => {
    const built = buildContext([], { maxResults: 6 });

    expect(built.tokenBudget).toBe(CONTEXT_TOKEN_BUDGET);
  });

  it('handles an empty candidate list', () => {
    expect(buildContext([], { maxResults: 6 })).toMatchObject({
      chunks: [],
      tokenCount: 0,
      droppedForBudget: 0,
    });
  });

  it('sums the token count of what it kept', () => {
    const built = buildContext(
      [
        candidate({ chunkId: 'a', tokenCount: 120 }),
        candidate({ chunkId: 'b', tokenCount: 80 }),
      ],
      { maxResults: 6 },
    );

    expect(built.tokenCount).toBe(200);
  });
});
