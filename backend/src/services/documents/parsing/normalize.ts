import type { ParsedPage } from './parser.interface.js';

/**
 * Text normalization, applied uniformly to every format
 * (docs/05-rag-and-chat.md §2.2).
 *
 * Every rule here exists because of a specific way raw extraction poisons
 * retrieval, and each is cheap. This runs once per document; the alternative
 * is living with the damage in every chunk, every embedding, and every answer
 * derived from them.
 */

/**
 * Collapses runs of whitespace **while preserving paragraph breaks**.
 *
 * The distinction is the whole point. Flattening all whitespace destroys the
 * paragraph boundaries the chunker splits on, and a chunker with no paragraph
 * signal falls straight through to splitting on sentences — producing chunks
 * that stop mid-argument. Two-or-more newlines therefore survive as exactly
 * two; everything else becomes a single space.
 */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Horizontal runs → one space. Newlines are handled separately below, so
    // this cannot eat a paragraph break.
    .replace(/[^\S\n]+/g, ' ')
    // Three or more newlines → exactly two. One paragraph break is a break;
    // six of them are a page artifact.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +\n/g, '\n')
    .replace(/\n +/g, '\n')
    .trim();
}

/**
 * Rejoins words split across a line break by hyphenation.
 *
 * PDFs justified to a column break "termination" into "termi-\nnation", and
 * the tokenizer then sees two fragments that match nothing. A query for
 * "termination" misses the one chunk that is entirely about it.
 *
 * Only joined when a lowercase letter precedes the hyphen and follows the
 * break — that is the shape line-wrap hyphenation takes. A genuine compound
 * that happens to sit at a line end ("cost-\neffective") is far rarer than a
 * wrapped word, and the failure mode of over-joining is a single merged token
 * rather than a permanently unfindable one.
 */
export function dehyphenate(text: string): string {
  return text.replace(/([a-z])-\n([a-z])/g, '$1$2');
}

/**
 * Strips control characters, keeping tab and newline.
 *
 * Extraction routinely emits form feeds, vertical tabs, and NULs from binary
 * containers. They contribute nothing to meaning, they survive into stored
 * chunk text, and a NUL in particular is rejected outright by Postgres `text`.
 */
export function stripControlCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/**
 * Unicode NFC, plus the punctuation substitutions that matter for matching.
 *
 * Without NFC, "é" composed and "é" decomposed are different strings — they
 * tokenize differently, embed differently, and a lexical search for one misses
 * the other. Smart quotes and dashes are folded for the same reason: a user
 * types an ASCII apostrophe, the document contains a typographic one, and the
 * keyword half of hybrid search silently fails to match.
 */
export function normalizeUnicode(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    // Non-breaking and other exotic spaces → a plain space, so whitespace
    // collapsing above can actually see them.
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    // Zero-width characters are invisible and break token boundaries.
    .replace(/[\u200b-\u200d\ufeff]/g, '');
}

/**
 * Removes headers and footers that repeat across pages.
 *
 * docs/05-rag-and-chat.md §2.2: "page furniture appearing in every chunk
 * poisons retrieval by adding a constant, meaningless signal". A document
 * whose every page begins "CONFIDENTIAL — ACME CORP" gives every chunk that
 * phrase, so every chunk looks slightly similar to every query mentioning
 * Acme, and the ranking between them stops meaning anything.
 *
 * Detection is deliberately conservative: a line only counts as furniture if
 * it appears in the same position on a **majority** of pages, and only the
 * first and last few lines of each page are considered. A sentence that
 * genuinely recurs in body text is not at a page boundary, and the cost of a
 * false positive — deleting real content — is far worse than leaving one
 * header in place.
 *
 * Skipped entirely below four pages. On a two-page document "appears on most
 * pages" is not evidence of anything.
 */
export function stripPageFurniture(pages: ParsedPage[]): ParsedPage[] {
  const MIN_PAGES = 4;
  const EDGE_LINES = 3;

  if (pages.length < MIN_PAGES) return pages;

  const counts = new Map<string, number>();

  const edgeLinesOf = (text: string): string[] => {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);

    /*
      On a sparse page the two slices overlap and "the edges" becomes "every
      line" — which is how a sentence in the middle of a three-line page gets
      classified as a header and deleted. Below the overlap threshold only the
      genuine first and last line count, which still catches a real header on a
      sparse page without putting body text at risk.
    */
    if (lines.length <= EDGE_LINES * 2) {
      return lines.length <= 1 ? lines : [lines[0] ?? '', lines[lines.length - 1] ?? ''];
    }

    return [...lines.slice(0, EDGE_LINES), ...lines.slice(-EDGE_LINES)];
  };

  for (const page of pages) {
    // A page contributes each distinct edge line once, so a line repeated
    // within one page cannot manufacture a majority on its own.
    for (const line of new Set(edgeLinesOf(page.text))) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  const threshold = Math.ceil(pages.length * 0.6);
  const furniture = new Set(
    [...counts.entries()]
      .filter(([line, count]) => {
        if (count < threshold) return false;
        // Long lines are prose that happens to repeat — a boilerplate clause,
        // a repeated definition — and deleting those loses real content.
        // Page furniture is short.
        if (line.length > 100) return false;
        // A bare page number differs on every page, so it never reaches the
        // threshold; what does is the surrounding label ("Page" / "of 42").
        return true;
      })
      .map(([line]) => line),
  );

  if (furniture.size === 0) return pages;

  return pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: page.text
      .split('\n')
      .filter((line) => !furniture.has(line.trim()))
      .join('\n'),
  }));
}

/**
 * The full pipeline, in the order the steps depend on each other.
 *
 * Order is load-bearing: Unicode folding must run before whitespace collapsing
 * (so exotic spaces are collapsible), and de-hyphenation must run before
 * newlines are collapsed (it matches across one).
 */
export function normalizeText(text: string): string {
  return collapseWhitespace(dehyphenate(stripControlCharacters(normalizeUnicode(text))));
}

/** Normalizes each page and drops any that end up empty. */
export function normalizePages(pages: ParsedPage[]): ParsedPage[] {
  return stripPageFurniture(pages)
    .map((page) => ({ pageNumber: page.pageNumber, text: normalizeText(page.text) }))
    .filter((page) => page.text.length > 0);
}

/**
 * A rough token count.
 *
 * Characters ÷ 4 is the standard English approximation and is used only for
 * reporting and for the chunker's budget — never for billing, where the
 * provider's own count is authoritative. A real tokenizer would add a
 * dependency and megabytes of vocabulary to make a number that is already
 * close enough for both uses.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
