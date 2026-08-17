import { describe, expect, it } from 'vitest';
import type { EvidenceChunkDto } from '@lumora/shared';
import { FakeLLMProvider } from '../../src/providers/llm/fake.provider.js';
import {
  buildPrompt,
  orderForAttention,
  truncateToTokens,
  TOKEN_BUDGET,
} from '../../src/services/chat/prompt.builder.js';
import {
  GROUNDING_REMINDER,
  SYSTEM_PROMPT,
} from '../../src/services/chat/system-prompt.js';
import { mapCitations, isUncited } from '../../src/services/chat/citation.mapper.js';
import { cleanTitle, fallbackTitle } from '../../src/services/chat/chat.service.js';

const provider = new FakeLLMProvider();

function source(overrides: Partial<EvidenceChunkDto> & { chunkId: string }): EvidenceChunkDto {
  return {
    documentId: 'doc-1',
    documentTitle: 'agreement.pdf',
    text: 'Either party may terminate with thirty days notice.',
    pageNumber: 3,
    sectionPath: '3. Termination',
    chunkIndex: 0,
    tokenCount: 20,
    score: 0.033,
    source: 'hybrid',
    vectorRank: 1,
    vectorScore: 0.8,
    lexicalRank: 1,
    lexicalScore: 0.04,
    ...overrides,
  };
}

describe('buildPrompt — structure', () => {
  it('follows the documented message order: system, history, question', () => {
    // docs/05-rag-and-chat.md §4.2.
    const built = buildPrompt(
      {
        question: 'What is the notice period?',
        chunks: [source({ chunkId: 'a' })],
        history: [
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' },
        ],
      },
      provider,
    );

    expect(built.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('puts the user question last, verbatim', () => {
    // §4.2: "the original question, verbatim". Never the normalized form —
    // that exists only for retrieval.
    const built = buildPrompt(
      { question: 'What is the notice period?', chunks: [source({ chunkId: 'a' })], history: [] },
      provider,
    );

    expect(built.messages.at(-1)).toEqual({
      role: 'user',
      content: 'What is the notice period?',
    });
  });

  it('numbers sources from 1, matching the UI', () => {
    /*
      §4.2: "Sources are numbered in the prompt exactly as they will be numbered
      in the UI, so the model's `[2]` and the user's `[2]` are the same passage
      without a remapping step that could drift."
    */
    const built = buildPrompt(
      {
        question: 'q',
        chunks: [source({ chunkId: 'a' }), source({ chunkId: 'b' })],
        history: [],
      },
      provider,
    );

    const system = built.messages[0]?.content ?? '';
    expect(system).toContain('[1] agreement.pdf · p.3 · 3. Termination');
    expect(system).toContain('[2] agreement.pdf');
    expect(system).not.toContain('[0]');
  });

  it('delimits the sources as untrusted data', () => {
    // §4.3 mitigation: "sources are delimited and explicitly labeled as
    // untrusted data".
    const built = buildPrompt(
      { question: 'q', chunks: [source({ chunkId: 'a' })], history: [] },
      provider,
    );

    const system = built.messages[0]?.content ?? '';
    expect(system).toContain('BEGIN SOURCES');
    expect(system).toContain('END SOURCES');
  });

  it('restates the grounding instruction after the context block', () => {
    /*
      §4.3's second named injection mitigation, and it is positional:
      instructions nearest the generation point carry the most weight, so an
      injection at the end of a chunk would otherwise be the last thing read.
    */
    const system = buildPrompt(
      { question: 'q', chunks: [source({ chunkId: 'a' })], history: [] },
      provider,
    ).messages[0]?.content ?? '';

    expect(system.indexOf(GROUNDING_REMINDER)).toBeGreaterThan(system.indexOf('END SOURCES'));
    expect(system.indexOf(SYSTEM_PROMPT)).toBeLessThan(system.indexOf('BEGIN SOURCES'));
  });

  it('omits page and section from the locator when the format has neither', () => {
    // An unpaginated DOCX has no page; printing "p.null" would be a citation
    // pointing at something that does not exist.
    const system = buildPrompt(
      {
        question: 'q',
        chunks: [source({ chunkId: 'a', pageNumber: null, sectionPath: null })],
        history: [],
      },
      provider,
    ).messages[0]?.content ?? '';

    expect(system).toContain('[1] agreement.pdf\n');
    expect(system).not.toContain('p.null');
  });

  it('renders history oldest first', () => {
    // §4.2: "last N turns, oldest first".
    const built = buildPrompt(
      {
        question: 'now',
        chunks: [source({ chunkId: 'a' })],
        history: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
          { role: 'user', content: 'third' },
        ],
      },
      provider,
    );

    expect(built.messages.slice(1, 4).map((message) => message.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('handles a prompt with no sources', () => {
    // Retrieval abstains before this point, so it should not happen — but a
    // builder that threw would turn a degraded turn into a 500.
    const built = buildPrompt({ question: 'q', chunks: [], history: [] }, provider);

    expect(built.sources).toEqual([]);
    expect(built.messages[0]?.content).toContain('(no sources)');
  });
});

describe('orderForAttention', () => {
  it('places the strongest evidence at both ends', () => {
    /*
      §4.2: "Source ordering places the highest-scoring chunks at the beginning
      and end of the context block rather than in strict descending order.
      Long-context attention is measurably weaker in the middle, so burying the
      best passage at position 4 of 6 reduces the chance it is used."
    */
    expect(orderForAttention([1, 2, 3, 4, 5])).toEqual([1, 3, 5, 4, 2]);
  });

  it('keeps the best first and the second-best last', () => {
    const ordered = orderForAttention(['best', 'second', 'third', 'fourth']);

    expect(ordered[0]).toBe('best');
    expect(ordered.at(-1)).toBe('second');
  });

  it('leaves one or two items alone', () => {
    expect(orderForAttention(['only'])).toEqual(['only']);
    expect(orderForAttention(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('never drops or duplicates an item', () => {
    const input = Array.from({ length: 9 }, (_, index) => index);

    expect([...orderForAttention(input)].sort((a, b) => a - b)).toEqual(input);
  });
});

describe('buildPrompt — token budget', () => {
  const longChunk = (id: string, tokens: number): EvidenceChunkDto =>
    source({ chunkId: id, text: 'word '.repeat(tokens), tokenCount: tokens });

  it('uses the documented allocations', () => {
    // docs/05-rag-and-chat.md §4.1's table.
    expect(TOKEN_BUDGET).toEqual({
      system: 400,
      context: 4_000,
      history: 2_000,
      question: 500,
      output: 2_000,
    });
  });

  it('drops the lowest-ranked chunks first when context overflows', () => {
    /*
      §4.1: "dropping the lowest-ranked chunks first, then compressing history —
      never by truncating mid-chunk, which produces a source that ends
      mid-clause and a citation that points at a fragment."
    */
    const built = buildPrompt(
      {
        question: 'q',
        chunks: [longChunk('top', 600), longChunk('middle', 600), longChunk('bottom', 600)],
        history: [],
      },
      provider,
      { ...TOKEN_BUDGET, context: 800 },
    );

    expect(built.sources.map((chunk) => chunk.chunkId)).toEqual(['top']);
    expect(built.dropped.chunks).toBe(2);
  });

  it('never truncates a chunk', () => {
    const text = 'A complete sentence that must survive intact. '.repeat(50);
    const built = buildPrompt(
      { question: 'q', chunks: [source({ chunkId: 'a', text })], history: [] },
      provider,
      { ...TOKEN_BUDGET, context: 10_000 },
    );

    expect(built.messages[0]?.content).toContain(text);
  });

  it('drops the oldest turns when history overflows', () => {
    // "Compressing history" means dropping the oldest: the turns nearest the
    // question are the ones that make it interpretable.
    const built = buildPrompt(
      {
        question: 'q',
        chunks: [source({ chunkId: 'a' })],
        history: [
          { role: 'user', content: 'x'.repeat(4_000) },
          { role: 'assistant', content: 'recent answer' },
        ],
      },
      provider,
      { ...TOKEN_BUDGET, history: 100 },
    );

    const contents = built.messages.slice(1, -1).map((message) => message.content);
    expect(contents).toEqual(['recent answer']);
    expect(built.dropped.turns).toBe(1);
  });

  it('keeps history turns whole', () => {
    // Half a previous answer reads as the assistant having been cut off, which
    // the model then imitates.
    const built = buildPrompt(
      {
        question: 'q',
        chunks: [source({ chunkId: 'a' })],
        history: [{ role: 'assistant', content: 'x'.repeat(4_000) }],
      },
      provider,
      { ...TOKEN_BUDGET, history: 100 },
    );

    expect(built.messages.slice(1, -1)).toEqual([]);
  });

  it('truncates an over-long question rather than refusing it', () => {
    // §4.1 caps the question at 500 tokens. A user who pastes an essay should
    // get an answer to the start of it, not a wall.
    const built = buildPrompt(
      { question: 'word '.repeat(2_000), chunks: [source({ chunkId: 'a' })], history: [] },
      provider,
    );

    expect(built.tokens.question).toBeLessThanOrEqual(TOKEN_BUDGET.question + 1);
  });

  it('reports the tokens each component used', () => {
    const built = buildPrompt(
      { question: 'q', chunks: [source({ chunkId: 'a' })], history: [] },
      provider,
    );

    expect(built.tokens.system).toBeGreaterThan(0);
    expect(built.tokens.context).toBeGreaterThan(0);
    expect(built.tokens.total).toBe(
      built.tokens.system + built.tokens.context + built.tokens.history + built.tokens.question,
    );
  });

  it('counts the source header, not only the passage', () => {
    // The `[n] document · p.N · section` line is real tokens; a budget that
    // ignored it would overrun by ~15 tokens per source.
    const withHeader = buildPrompt(
      { question: 'q', chunks: [source({ chunkId: 'a' })], history: [] },
      provider,
    );

    expect(withHeader.tokens.context).toBeGreaterThan(
      provider.countTokens(source({ chunkId: 'a' }).text),
    );
  });
});

describe('truncateToTokens', () => {
  it('leaves a short string alone', () => {
    expect(truncateToTokens('short', 100, provider)).toBe('short');
  });

  it('cuts on a word boundary', () => {
    const cut = truncateToTokens('alpha beta gamma delta epsilon zeta', 4, provider);

    expect(cut.endsWith(' ')).toBe(false);
    // Never mid-word: a fragment is something the model tries to interpret.
    expect('alpha beta gamma delta epsilon zeta'.startsWith(cut)).toBe(true);
  });
});

describe('mapCitations', () => {
  const sources = [source({ chunkId: 'c1' }), source({ chunkId: 'c2' }), source({ chunkId: 'c3' })];

  it('maps each marker to the source it refers to', () => {
    const result = mapCitations('Claim one [1]. Claim two [3].', sources);

    expect(result.citations.map((citation) => [citation.citationIndex, citation.chunkId])).toEqual([
      [1, 'c1'],
      [3, 'c3'],
    ]);
  });

  it('snapshots the cited text', () => {
    /*
      §5 defence 4: the snapshot is what keeps a past answer verifiable "after
      the document is deleted".
    */
    const result = mapCitations('Claim [1].', sources);

    expect(result.citations[0]?.contentSnapshot).toBe(sources[0]?.text);
  });

  it('includes only the sources the model actually cited', () => {
    // Listing all six under an answer that used two is a claim about grounding
    // that is not true.
    expect(mapCitations('Only this one [2].', sources).citations).toHaveLength(1);
  });

  it('deduplicates a source cited several times', () => {
    const result = mapCitations('A [1]. B [1]. C [1].', sources);

    expect(result.citations).toHaveLength(1);
  });

  it('strips a marker that references no source', () => {
    /*
      §5 defence 3: "Out-of-range markers are stripped before display and
      logged as a quality signal. A citation the user can click and find empty
      is worse than no citation."
    */
    const result = mapCitations('Real [1]. Invented [9].', sources);

    expect(result.content).toBe('Real [1]. Invented.');
    expect(result.invalidMarkers).toEqual([9]);
  });

  it('leaves no stranded space before punctuation', () => {
    // "Revenue grew 12% ." draws the eye to exactly where something was
    // removed.
    expect(mapCitations('Revenue grew 12% [7].', sources).content).toBe('Revenue grew 12%.');
  });

  it('does not touch markdown links', () => {
    const content = 'See [the docs](https://example.test) and source [1].';

    expect(mapCitations(content, sources).content).toBe(content);
  });

  it('does not touch array indexing inside a code block', () => {
    // Stripping `items[0]` out of a code block corrupts the answer.
    const content = 'Use `items[0]` to read the first entry [1].';

    expect(mapCitations(content, sources).content).toBe(content);
  });

  it('does not treat a footnote marker as a citation', () => {
    const content = 'A footnote[^1] is not a citation.';

    expect(mapCitations(content, sources).citations).toEqual([]);
    expect(mapCitations(content, sources).content).toBe(content);
  });

  it('orders citations ascending regardless of the order they appear', () => {
    const result = mapCitations('Third [3] then first [1].', sources);

    expect(result.citations.map((citation) => citation.citationIndex)).toEqual([1, 3]);
  });

  it('does not renumber', () => {
    /*
      §4.2 requires "the model's `[2]` and the user's `[2]` are the same
      passage without a remapping step that could drift" — renumbering after
      the fact is exactly that step.
    */
    const result = mapCitations('Only the third [3].', sources);

    expect(result.citations[0]?.citationIndex).toBe(3);
    expect(result.content).toContain('[3]');
  });

  it('handles an answer with no markers', () => {
    const result = mapCitations('An answer with no citations.', sources);

    expect(result.citations).toEqual([]);
    expect(result.content).toBe('An answer with no citations.');
  });
});

describe('isUncited', () => {
  it('flags an answer that cited nothing despite having sources', () => {
    const sources = [source({ chunkId: 'c1' })];

    expect(isUncited(mapCitations('No markers here.', sources), sources)).toBe(true);
  });

  it('does not flag an abstention with no sources', () => {
    expect(isUncited(mapCitations('I could not find that.', []), [])).toBe(false);
  });
});

describe('cleanTitle', () => {
  it('strips the quotes models wrap titles in', () => {
    expect(cleanTitle('"Notice Period Questions"')).toBe('Notice Period Questions');
  });

  it('removes a trailing period', () => {
    expect(cleanTitle('Notice period terms.')).toBe('Notice period terms');
  });

  it('caps at six words', () => {
    // §7: "constrained to ≤6 words" — a longer title truncates in the sidebar
    // to something unreadable.
    expect(cleanTitle('one two three four five six seven eight')).toBe(
      'one two three four five six',
    );
  });

  it('caps long words by characters too', () => {
    const title = cleanTitle('Supercalifragilistic Extraordinarily Verbose Titlecase Wording Here');

    expect(title.length).toBeLessThanOrEqual(60);
  });

  it('collapses whitespace', () => {
    expect(cleanTitle('  Notice   period  ')).toBe('Notice period');
  });

  it('returns empty for an empty reply, so nothing is saved', () => {
    expect(cleanTitle('   ')).toBe('');
  });
});

describe('fallbackTitle', () => {
  /*
    The name a conversation gets when the model cannot supply one.

    This exists because the sidebar is navigation now: a provider outage that
    leaves every row reading "New conversation" does not degrade the feature,
    it removes it.
  */

  it('starts the title at the subject, not at the politeness', () => {
    expect(fallbackTitle('Can you explain how the hybrid retrieval pipeline works?')).toBe(
      'Hybrid retrieval pipeline works',
    );
  });

  it('drops a leading article once the filler in front of it is gone', () => {
    expect(fallbackTitle('Explain the retrieval pipeline in Lumora')).toBe(
      'Retrieval pipeline in Lumora',
    );
  });

  it('consumes the longest matching opener, not the shortest', () => {
    // "can you" alone would leave "explain" stranded at the head of the title.
    expect(fallbackTitle('Can you explain Kubernetes ingress')).toBe('Kubernetes ingress');
  });

  it('strips the question mark a question actually ends on', () => {
    expect(fallbackTitle('How does Kubernetes ingress work?')).toBe(
      'How does Kubernetes ingress work',
    );
  });

  it('leaves identifiers alone instead of title-casing them', () => {
    // "Pg_Isready Timeout" is not searchable; "pg_isready timeout" is.
    expect(fallbackTitle('help me debug pg_isready timeout')).toBe('Pg_isready timeout');
  });

  it('obeys the same six-word cap as a generated title', () => {
    const title = fallbackTitle('one two three four five six seven eight nine ten');

    expect(title.split(' ').length).toBeLessThanOrEqual(6);
  });

  it('never exceeds the sidebar character cap', () => {
    const title = fallbackTitle(
      'Supercalifragilistic extraordinarily verbose questioning about wording here',
    );

    expect(title.length).toBeLessThanOrEqual(60);
  });

  it('keeps the original question when it is nothing but filler', () => {
    // Better a weak label than an empty one — an empty title would fall
    // through and leave the placeholder.
    expect(fallbackTitle('please')).toBe('Please');
  });

  it('returns empty for an empty question, so nothing is saved', () => {
    expect(fallbackTitle('   ')).toBe('');
  });
});
