import { describe, expect, it } from 'vitest';
import {
  collapseWhitespace,
  dehyphenate,
  estimateTokens,
  normalizePages,
  normalizeText,
  normalizeUnicode,
  stripControlCharacters,
  stripPageFurniture,
} from '../../src/services/documents/parsing/normalize.js';

/**
 * Normalization is where retrieval quality is silently won or lost. Every rule
 * here exists because a specific extraction artifact poisons search, so each
 * test names the artifact rather than the transformation.
 */
describe('collapseWhitespace', () => {
  it('preserves paragraph breaks while collapsing everything else', () => {
    // The distinction the chunker depends on: without paragraph boundaries it
    // falls through to splitting on sentences and stops mid-argument.
    const result = collapseWhitespace('First   paragraph.\n\n\n\nSecond    paragraph.');
    expect(result).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('collapses horizontal runs without eating single newlines', () => {
    expect(collapseWhitespace('a\t\t  b\nc')).toBe('a b\nc');
  });

  it('normalizes CRLF, so a Windows-authored file chunks like any other', () => {
    expect(collapseWhitespace('one\r\ntwo\r\n\r\nthree')).toBe('one\ntwo\n\nthree');
  });

  it('strips space adjacent to newlines', () => {
    expect(collapseWhitespace('line   \n   next')).toBe('line\nnext');
  });
});

describe('dehyphenate', () => {
  it('rejoins a word split across a line break', () => {
    // A query for "termination" must not miss the one chunk about it.
    expect(dehyphenate('termi-\nnation')).toBe('termination');
  });

  it('leaves a hyphen that is not a line-wrap alone', () => {
    expect(dehyphenate('cost-effective')).toBe('cost-effective');
  });

  it('leaves a hyphen before an uppercase word alone', () => {
    // "Anglo-\nSaxon" is a real compound the layout happened to break; joining
    // it is not obviously right, and the rule deliberately declines.
    expect(dehyphenate('Anglo-\nSaxon')).toBe('Anglo-\nSaxon');
  });
});

describe('stripControlCharacters', () => {
  it('removes NUL, which Postgres rejects outright in a text column', () => {
    expect(stripControlCharacters('a\u0000b')).toBe('ab');
  });

  it('removes form feeds and vertical tabs from paginated extraction', () => {
    expect(stripControlCharacters('page\u000conepage\u000btwo')).toBe('pageonepagetwo');
  });

  it('keeps tab and newline, which carry structure', () => {
    expect(stripControlCharacters('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('normalizeUnicode', () => {
  it('composes decomposed characters so both spellings tokenize alike', () => {
    const decomposed = 'cafe\u0301';
    expect(normalizeUnicode(decomposed)).toBe('café');
    expect(normalizeUnicode(decomposed)).toHaveLength(4);
  });

  it('folds typographic quotes to ASCII', () => {
    // A user types an ASCII apostrophe; the document contains a curly one, and
    // the lexical half of hybrid search silently fails to match.
    expect(normalizeUnicode('‘quoted’ and “quoted”')).toBe(
      `'quoted' and "quoted"`,
    );
  });

  it('folds en and em dashes and ellipses', () => {
    expect(normalizeUnicode('a–b—c…')).toBe('a-b-c...');
  });

  it('converts non-breaking and exotic spaces to a plain space', () => {
    // Otherwise whitespace collapsing cannot see them and they survive into
    // stored chunk text.
    expect(normalizeUnicode('a\u00a0b\u2003c\u3000d')).toBe('a b c d');
  });

  it('removes zero-width characters that break token boundaries', () => {
    expect(normalizeUnicode('in\u200bvis\u200dible\ufeff')).toBe('invisible');
  });
});

describe('normalizeText', () => {
  it('applies the stages in an order where each can see the previous', () => {
    // Unicode folding must precede whitespace collapsing (so a non-breaking
    // space is collapsible), and de-hyphenation must precede newline
    // collapsing (it matches across one).
    const raw = 'The termi-\nnation\u00a0clause’s   scope.\n\n\n\nNext.';
    expect(normalizeText(raw)).toBe("The termination clause's scope.\n\nNext.");
  });

  it('is idempotent — running it twice changes nothing', () => {
    // A retry re-parses from the stored bytes, so a non-idempotent normalizer
    // would make the second attempt produce different chunks from the first.
    const once = normalizeText('a\u00a0\u00a0b—c\n\n\n\nd');
    expect(normalizeText(once)).toBe(once);
  });
});

describe('stripPageFurniture', () => {
  const withHeader = (bodies: string[]): { pageNumber: number; text: string }[] =>
    bodies.map((body, index) => ({
      pageNumber: index + 1,
      text: `CONFIDENTIAL - ACME CORP\n${body}\nPage ${String(index + 1)} of ${String(bodies.length)}`,
    }));

  it('removes a header repeated on a majority of pages', () => {
    // Constant text in every chunk adds a meaningless signal that makes every
    // chunk look slightly similar to every Acme-mentioning query.
    const pages = withHeader(['Alpha content.', 'Beta content.', 'Gamma content.', 'Delta content.']);
    const stripped = stripPageFurniture(pages);

    for (const page of stripped) {
      expect(page.text).not.toContain('CONFIDENTIAL');
    }
    expect(stripped[0]?.text).toContain('Alpha content.');
  });

  it('keeps body text that happens to repeat but is not at a page edge', () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({
      pageNumber: index + 1,
      text: `Top line ${String(index)}\nRecurring middle sentence.\nBottom line ${String(index)}`,
    }));

    for (const page of stripPageFurniture(pages)) {
      expect(page.text).toContain('Recurring middle sentence.');
    }
  });

  it('does nothing below four pages, where a majority proves nothing', () => {
    const pages = withHeader(['One.', 'Two.']);
    expect(stripPageFurniture(pages)).toEqual(pages);
  });

  it('keeps long repeated lines, which are prose rather than furniture', () => {
    // A boilerplate clause repeated on every page is real content, and
    // deleting it loses something the user may ask about.
    const clause =
      'This agreement is governed by the laws of the State of Delaware and any dispute arising under it shall be resolved by binding arbitration.';
    const pages = Array.from({ length: 5 }, (_, index) => ({
      pageNumber: index + 1,
      text: `${clause}\nUnique body ${String(index)}`,
    }));

    for (const page of stripPageFurniture(pages)) {
      expect(page.text).toContain(clause);
    }
  });

  it('does not let a line repeated within one page manufacture a majority', () => {
    const pages = Array.from({ length: 5 }, (_, index) => ({
      pageNumber: index + 1,
      text:
        index === 0
          ? 'Repeated\nRepeated\nRepeated\nbody'
          : `Distinct top ${String(index)}\nbody\nDistinct bottom ${String(index)}`,
    }));

    expect(stripPageFurniture(pages)[0]?.text).toContain('Repeated');
  });
});

describe('normalizePages', () => {
  it('normalizes each page and drops the ones that end up empty', () => {
    const pages = [
      { pageNumber: 1, text: 'Real   content.' },
      { pageNumber: 2, text: '   \n\n  ' },
      { pageNumber: 3, text: 'More content.' },
    ];

    const result = normalizePages(pages);

    expect(result).toEqual([
      { pageNumber: 1, text: 'Real content.' },
      { pageNumber: 3, text: 'More content.' },
    ]);
  });

  it('keeps original page numbers after dropping, so citations stay correct', () => {
    const result = normalizePages([
      { pageNumber: 1, text: '' },
      { pageNumber: 2, text: 'Content.' },
    ]);

    expect(result[0]?.pageNumber).toBe(2);
  });
});

describe('estimateTokens', () => {
  it('approximates characters over four', () => {
    expect(estimateTokens('12345678')).toBe(2);
  });

  it('rounds up, so a short string is never zero tokens', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('')).toBe(0);
  });
});
