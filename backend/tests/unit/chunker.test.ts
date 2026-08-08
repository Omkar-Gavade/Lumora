import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../../src/services/documents/chunking/chunker.js';
import {
  DEFAULT_CHUNK_OPTIONS,
  type ChunkOptions,
} from '../../src/services/documents/chunking/chunk.types.js';
import type {
  ParsedDocument,
  ParsedHeading,
} from '../../src/services/documents/parsing/parser.interface.js';

/**
 * Chunking is "the highest-leverage decision in the whole system"
 * (docs/05-rag-and-chat.md §2.3), so these tests are about the *rules* that
 * raise quality, not about hitting a token count.
 *
 * Every assertion names the retrieval failure it prevents.
 */

/** Builds a `ParsedDocument` from raw text, locating headings by offset. */
function parsedFrom(text: string, headings: { level: number; text: string }[] = []): ParsedDocument {
  const located: ParsedHeading[] = [];
  let cursor = 0;

  for (const heading of headings) {
    const index = text.indexOf(heading.text, cursor);
    if (index === -1) throw new Error(`heading "${heading.text}" is not in the text`);
    located.push({ level: heading.level, text: heading.text, charOffset: index });
    cursor = index + heading.text.length;
  }

  return {
    text,
    pages: [{ pageNumber: 1, text }],
    headings: located,
    metadata: { pageCount: 1 },
  };
}

/** ~n tokens of prose, at the 4-chars-per-token estimate the chunker uses. */
function prose(tokens: number, seed = 'word'): string {
  const sentence = `The ${seed} clause governs every party bound by this agreement. `;
  const perSentence = Math.ceil(sentence.length / 4);
  return sentence.repeat(Math.max(1, Math.ceil(tokens / perSentence))).trim();
}

const SMALL: ChunkOptions = {
  targetTokens: 60,
  maxTokens: 100,
  minTokens: 10,
  overlapTokens: 0,
};

describe('determinism', () => {
  it('produces byte-identical chunks on every run', () => {
    /*
      The property the entire idempotency story rests on. If chunking varied,
      an upsert on `(document_id, chunk_index)` would silently rewrite text
      whose vectors were already paid for, and a "duplicate prevention" test
      would be asserting something that is not true.
    */
    const parsed = parsedFrom(
      `# Agreement\n\n${prose(200)}\n\n## Termination\n\n${prose(300, 'notice')}`,
      [
        { level: 1, text: '# Agreement' },
        { level: 2, text: '## Termination' },
      ],
    );

    const first = chunkDocument(parsed);
    const second = chunkDocument(parsed);
    const third = chunkDocument(parsed);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });

  it('numbers chunks contiguously from zero', () => {
    // `chunk_index` is half the idempotency key and is what orders a document
    // for reading. A gap would make an upsert miss and leave a stale row.
    const chunks = chunkDocument(parsedFrom(prose(2_000)), SMALL);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
  });
});

describe('size rules', () => {
  it('keeps chunks at or under the hard maximum', () => {
    const chunks = chunkDocument(parsedFrom(prose(4_000)), SMALL);

    for (const chunk of chunks) {
      // The maximum exists because an oversized chunk is silently truncated by
      // the embedding provider — the excess is indexed as nothing at all.
      expect(chunk.tokenCount).toBeLessThanOrEqual(SMALL.maxTokens);
    }
  });

  it('merges an undersized trailing fragment rather than indexing noise', () => {
    // "See Appendix B." is retrievable, ranks on "appendix", and answers
    // nothing (docs §2.3).
    const parsed = parsedFrom(`${prose(120)}\n\nSee Appendix B.`);

    const chunks = chunkDocument(parsed, SMALL);

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThanOrEqual(SMALL.minTokens);
    }
    expect(chunks.some((chunk) => chunk.content.includes('See Appendix B.'))).toBe(true);
  });

  it('never drops text when merging', () => {
    // Merging is a size optimisation; losing a sentence to it would be data
    // loss, and the lost sentence may be the only place a fact appears.
    const parsed = parsedFrom(`${prose(100)}\n\nA short tail.`);

    const chunks = chunkDocument(parsed, SMALL);

    expect(chunks.map((chunk) => chunk.content).join(' ')).toContain('A short tail.');
  });

  it('emits a single chunk for a document below the target', () => {
    // Splitting a short document costs context for no benefit.
    const chunks = chunkDocument(parsedFrom('One short paragraph about termination.'));

    expect(chunks).toHaveLength(1);
  });

  it('produces no chunks for an empty document', () => {
    expect(chunkDocument(parsedFrom(''))).toEqual([]);
  });
});

describe('structure-aware splitting', () => {
  it('does not split across a heading boundary', () => {
    /*
      "Split on the strongest available boundary first." A chunk containing the
      tail of one section and the head of the next has two section paths and is
      correctly described by neither.
    */
    const parsed = parsedFrom(
      `# Scope\n\nScope body text here.\n\n# Termination\n\nTermination body text here.`,
      [
        { level: 1, text: '# Scope' },
        { level: 1, text: '# Termination' },
      ],
    );

    const chunks = chunkDocument(parsed);

    for (const chunk of chunks) {
      const hasScope = chunk.content.includes('Scope body');
      const hasTermination = chunk.content.includes('Termination body');
      expect(hasScope && hasTermination).toBe(false);
    }
  });

  it('records the full heading stack as the section path', () => {
    // "3.2 Notice" alone says nothing about which agreement or clause it
    // belongs to.
    const parsed = parsedFrom(
      `# Employment Agreement\n\nIntro.\n\n## 3. Termination\n\nBody.\n\n### 3.2 Notice\n\nNotice body.`,
      [
        { level: 1, text: '# Employment Agreement' },
        { level: 2, text: '## 3. Termination' },
        { level: 3, text: '### 3.2 Notice' },
      ],
    );

    const chunks = chunkDocument(parsed);
    const deepest = chunks.find((chunk) => chunk.content.includes('Notice body'));

    expect(deepest?.sectionPath).toBe('# Employment Agreement > ## 3. Termination > ### 3.2 Notice');
  });

  it('pops the heading stack so a sibling does not inherit a subsection', () => {
    const parsed = parsedFrom(
      `# Doc\n\n## Alpha\n\nAlpha body.\n\n### Deep\n\nDeep body.\n\n## Beta\n\nBeta body.`,
      [
        { level: 1, text: '# Doc' },
        { level: 2, text: '## Alpha' },
        { level: 3, text: '### Deep' },
        { level: 2, text: '## Beta' },
      ],
    );

    const chunks = chunkDocument(parsed);
    const beta = chunks.find((chunk) => chunk.content.includes('Beta body'));

    expect(beta?.sectionPath).toBe('# Doc > ## Beta');
    expect(beta?.sectionPath).not.toContain('Deep');
  });

  it('splits on paragraph boundaries before descending to sentences', () => {
    // Descending is a cost: every level down loses context the level above
    // was carrying.
    const parsed = parsedFrom([prose(50), prose(50, 'second'), prose(50, 'third')].join('\n\n'));

    const chunks = chunkDocument(parsed, SMALL);

    for (const chunk of chunks) {
      // A paragraph-level split leaves each paragraph's final period intact.
      expect(chunk.content.trimEnd().endsWith('.')).toBe(true);
    }
  });

  it('never splits mid-sentence when descending into a long paragraph', () => {
    /*
      §2.3's first rule. A chunk ending "the notice period shall be" is
      unusable to a reader and embeds to something between the two ideas it
      straddles.
    */
    const parsed = parsedFrom(prose(600));

    const chunks = chunkDocument(parsed, SMALL);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.trimEnd()).toMatch(/[.!?]$/);
    }
  });

  it('splits a single oversized sentence rather than emitting a truncated chunk', () => {
    // A 900-token sentence exists — a legal enumeration, a generated list. The
    // boundary is wrong, but every word must be present exactly once.
    const runOn = `Item ${Array.from({ length: 400 }, (_, i) => `alpha${String(i)}`).join(', ')}`;

    const chunks = chunkDocument(parsedFrom(runOn), SMALL);

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(SMALL.maxTokens);
    }
    expect(chunks.map((chunk) => chunk.content).join(' ')).toContain('alpha399');
  });
});

describe('tables', () => {
  const header = '| Year | Revenue | Margin |';
  const separator = '|------|---------|--------|';

  it('keeps a table under the maximum in one chunk', () => {
    const table = [header, separator, '| 2021 | 100 | 12 |', '| 2022 | 140 | 15 |'].join('\n');

    const chunks = chunkDocument(parsedFrom(table));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('| 2022 | 140 | 15 |');
  });

  it('repeats the header row into every part of a split table', () => {
    /*
      §2.3: "a table fragment without its header is unreadable to both the
      model and the user". A row reading `| 2021 | 100 | 12 |` with no header
      is noise in the index and a citation that explains nothing.
    */
    const rows = Array.from(
      { length: 120 },
      (_, index) => `| ${String(2000 + index)} | ${String(index * 7)} | ${String(index % 30)} |`,
    );
    const table = [header, separator, ...rows].join('\n');

    const chunks = chunkDocument(parsedFrom(table), SMALL);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content).toContain(header);
      expect(chunk.content).toContain(separator);
    }
  });

  it('does not treat a paragraph containing one pipe as a table', () => {
    // `ls | grep foo` in prose is not a table, and detecting it as one fuses
    // the surrounding text into an indivisible block.
    const parsed = parsedFrom('Run the command ls | grep foo to list matches.');

    const chunks = chunkDocument(parsed);

    expect(chunks[0]?.content).toContain('ls | grep foo');
  });
});

describe('code blocks', () => {
  it('keeps a fenced code block intact', () => {
    // §2.3: "Never split a code block." Two halves of a function are each
    // invalid code and each match nothing.
    const code = ['```ts', 'function add(a: number, b: number) {', '  return a + b;', '}', '```'].join(
      '\n',
    );
    const parsed = parsedFrom(`Intro paragraph.\n\n${code}\n\nOutro paragraph.`);

    const chunks = chunkDocument(parsed);
    const withCode = chunks.filter((chunk) => chunk.content.includes('function add'));

    expect(withCode).toHaveLength(1);
    expect(withCode[0]?.content).toContain('return a + b;');
    expect(withCode[0]?.content).toContain('```');
  });

  it('does not treat a blank line inside a fence as a paragraph break', () => {
    const code = ['```', 'first();', '', 'second();', '```'].join('\n');
    const parsed = parsedFrom(code);

    const chunks = chunkDocument(parsed);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('first();');
    expect(chunks[0]?.content).toContain('second();');
  });

  it('splits an oversized code block on line boundaries, never mid-token', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `const value${String(index)} = ${String(index)};`);
    const parsed = parsedFrom(['```ts', ...lines, '```'].join('\n'));

    const chunks = chunkDocument(parsed, SMALL);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      for (const line of chunk.content.split('\n')) {
        // A character-level split would leave `const value12` with no `= 12;`.
        if (line.startsWith('const ')) expect(line).toMatch(/;$/);
      }
    }
  });
});

describe('contextual enrichment', () => {
  it('prepends the section path to the embedded text but not to the stored content', () => {
    /*
      "The single cheapest accuracy win available" (§2.3) — without it, a chunk
      reading "Either party may terminate with 30 days notice" carries no signal
      that it concerns *employment* termination.

      Kept out of `content` because that is what a citation shows the user and
      what `content_tsv` indexes; storing the enriched form would put the
      section path in every quoted passage and index it twice.
    */
    const parsed = parsedFrom(
      `# Employment Agreement\n\n## Termination\n\nEither party may terminate with 30 days notice.`,
      [
        { level: 1, text: '# Employment Agreement' },
        { level: 2, text: '## Termination' },
      ],
    );

    const chunk = chunkDocument(parsed)[0];

    expect(chunk?.embedText).toContain('# Employment Agreement > ## Termination');
    expect(chunk?.embedText).toContain('Either party may terminate');
    expect(chunk?.content).not.toContain('>');
  });

  it('leaves embedText equal to content outside any heading', () => {
    const chunk = chunkDocument(parsedFrom('Body text with no heading above it.'))[0];

    expect(chunk?.sectionPath).toBeNull();
    expect(chunk?.embedText).toBe(chunk?.content);
  });

  it('does not let a long section path push a chunk over the maximum', () => {
    // Enrichment is applied after every size decision, so a deeply nested
    // heading cannot cause a split.
    const deepPath = '# ' + 'Very Long Heading Name Indeed '.repeat(10);
    const parsed = parsedFrom(`${deepPath}\n\n${prose(50)}`, [{ level: 1, text: deepPath.trim() }]);

    const chunks = chunkDocument(parsed, SMALL);

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(SMALL.maxTokens);
    }
  });
});

describe('overlap', () => {
  const withOverlap: ChunkOptions = { ...SMALL, overlapTokens: 20 };

  it('carries the previous chunk’s tail into the next', () => {
    // §2.3: overlap "exists so a fact spanning a boundary is fully present in
    // at least one chunk".
    const parsed = parsedFrom(prose(400));

    const chunks = chunkDocument(parsed, withOverlap);

    expect(chunks.length).toBeGreaterThan(1);
    const second = chunks[1]?.content ?? '';
    const firstTail = (chunks[0]?.content ?? '').slice(-40);
    expect(second.includes(firstTail.trim().slice(-20))).toBe(true);
  });

  it('overlaps on whole sentences only', () => {
    // Half a sentence as overlap reintroduces exactly the mid-sentence split
    // the strategy exists to avoid.
    const chunks = chunkDocument(parsedFrom(prose(400)), withOverlap);

    for (const chunk of chunks.slice(1)) {
      const firstLine = chunk.content.split('\n')[0] ?? '';
      expect(firstLine.trimEnd()).toMatch(/[.!?]$/);
    }
  });

  it('does not overlap across a section boundary', () => {
    // A paragraph about termination prefixed to a chunk about compensation
    // makes both chunks slightly about the wrong thing.
    const parsed = parsedFrom(
      `# Termination\n\n${prose(80, 'termination')}\n\n# Compensation\n\n${prose(80, 'salary')}`,
      [
        { level: 1, text: '# Termination' },
        { level: 1, text: '# Compensation' },
      ],
    );

    const chunks = chunkDocument(parsed, withOverlap);
    const compensation = chunks.filter((chunk) => chunk.sectionPath === '# Compensation');

    expect(compensation.length).toBeGreaterThan(0);
    expect(compensation[0]?.content).not.toContain('termination clause');
  });

  it('emits no overlap when configured to zero', () => {
    const none = chunkDocument(parsedFrom(prose(400)), SMALL);
    const some = chunkDocument(parsedFrom(prose(400)), withOverlap);

    const totalNone = none.reduce((sum, chunk) => sum + chunk.content.length, 0);
    const totalSome = some.reduce((sum, chunk) => sum + chunk.content.length, 0);

    expect(totalSome).toBeGreaterThan(totalNone);
  });
});

describe('citation metadata', () => {
  it('records char offsets that locate the chunk in the source text', () => {
    // `char_start`/`char_end` are what make a citation point at a place rather
    // than at a document (§2.3).
    const text = `${prose(60)}\n\n${prose(60, 'second')}`;
    const chunks = chunkDocument(parsedFrom(text), SMALL);

    for (const chunk of chunks) {
      expect(chunk.charStart).toBeGreaterThanOrEqual(0);
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
      expect(chunk.charStart).toBeLessThanOrEqual(text.length);
    }
  });

  it('attributes each chunk to the page its text starts on', () => {
    const pages = [
      { pageNumber: 1, text: prose(40, 'first') },
      { pageNumber: 2, text: prose(40, 'second') },
      { pageNumber: 3, text: prose(40, 'third') },
    ];
    const parsed: ParsedDocument = {
      text: pages.map((page) => page.text).join('\n\n'),
      pages,
      headings: [],
      metadata: { pageCount: 3 },
    };

    const chunks = chunkDocument(parsed, SMALL);

    for (const chunk of chunks) {
      expect(chunk.pageNumber).not.toBeNull();
      expect(chunk.pageNumber).toBeGreaterThanOrEqual(1);
      expect(chunk.pageNumber).toBeLessThanOrEqual(3);
    }
    // A chunk containing page-3 text must not claim page 1.
    const third = chunks.find((chunk) => chunk.content.includes('third clause'));
    expect(third?.pageNumber).toBeGreaterThan(1);
  });

  it('reports a null page for unpaginated formats', () => {
    // A DOCX has no fixed pagination; claiming page 1 would produce a citation
    // pointing at something the format does not have.
    const chunks = chunkDocument(parsedFrom('Body text of a DOCX.'));

    expect(chunks[0]?.pageNumber).toBeNull();
  });
});

describe('documented defaults', () => {
  it('uses the parameters from docs/05-rag-and-chat.md §2.3', () => {
    // 512 target, 800 hard max, 100 minimum, ~15% overlap. These are load
    // bearing, not placeholders — see §2.3's justification for each.
    expect(DEFAULT_CHUNK_OPTIONS).toEqual({
      targetTokens: 512,
      maxTokens: 800,
      minTokens: 100,
      overlapTokens: 75,
    });
  });

  it('produces chunks near the target on ordinary prose', () => {
    const chunks = chunkDocument(parsedFrom(prose(5_000)));

    expect(chunks.length).toBeGreaterThan(5);
    const average =
      chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0) / chunks.length;

    // A chunker averaging half its target is one that descended too eagerly;
    // one averaging the maximum is one that never descended at all.
    expect(average).toBeGreaterThan(DEFAULT_CHUNK_OPTIONS.targetTokens * 0.5);
    expect(average).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxTokens);
  });
});
