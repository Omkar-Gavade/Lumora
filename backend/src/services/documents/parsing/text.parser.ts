import { estimateTokens, normalizeText } from './normalize.js';
import {
  ParseError,
  type DocumentParser,
  type ParsedDocument,
  type ParsedHeading,
} from './parser.interface.js';

/**
 * Decodes bytes to a string, honouring a BOM.
 *
 * docs/05-rag-and-chat.md §2.2 asks for "encoding detection, then
 * normalization". Full charset detection is a dependency and a guess; a BOM is
 * an explicit declaration and covers the case that actually appears —
 * UTF-16 files exported from Windows tooling, which decode as UTF-8 into
 * alternating NUL bytes and are then indistinguishable from binary.
 *
 * Without a BOM the bytes are treated as UTF-8, which is correct for
 * essentially everything else and is what the upload validator already
 * verified them to be.
 */
function decode(bytes: Buffer): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      // UTF-16BE. Node has no decoder for it, so the pairs are swapped into LE.
      const swapped = Buffer.from(bytes.subarray(2));
      swapped.swap16();
      return swapped.toString('utf16le');
    }
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }

  return bytes.toString('utf8');
}

/**
 * Plain text.
 *
 * Unpaginated, so it reports a single page numbered 1 — the chunker and the
 * citation layer then need no special case for formats without pages.
 */
export class TextParser implements DocumentParser {
  readonly name = 'text';
  readonly supports = ['text/plain'] as const;

  /*
    `async` even though nothing here awaits.

    The interface returns a promise, so a caller is entitled to write
    `parser.parse(bytes).catch(...)`. A synchronous `throw` from a
    promise-returning function escapes before that handler is attached and
    crashes the caller instead of rejecting — `async` makes every failure a
    rejection, which is the contract the interface advertises.
  */
  // eslint-disable-next-line @typescript-eslint/require-await
  async parse(bytes: Buffer): Promise<ParsedDocument> {
    const text = normalizeText(decode(bytes));

    if (text.length === 0) {
      throw new ParseError('EMPTY_CONTENT', 'That file contains no readable text.');
    }

    return {
      text,
      pages: [{ pageNumber: 1, text }],
      headings: [],
      metadata: { pageCount: 1 },
    };
  }
}

/**
 * Markdown.
 *
 * docs/05-rag-and-chat.md §2.2: "parsed to an AST; the heading tree becomes
 * the section hierarchy directly". The heading tree is extracted here without
 * a Markdown AST dependency, because the only structure the chunker consumes
 * is ATX headings and those are unambiguous at line level — a `#` in column
 * one, outside a fenced code block. Pulling in a full CommonMark parser to
 * find them would add a dependency to answer a question a regex answers
 * exactly.
 *
 * Fenced blocks are tracked precisely because of that caveat: a `# comment`
 * inside a shell snippet is not a section heading, and treating it as one puts
 * a bogus entry in the section path that gets prepended to every chunk beneath
 * it.
 */
export class MarkdownParser implements DocumentParser {
  readonly name = 'markdown';
  readonly supports = ['text/markdown'] as const;

  /** `async` for the same reason as `TextParser.parse` — see above. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async parse(bytes: Buffer): Promise<ParsedDocument> {
    const raw = decode(bytes);
    const headings = extractMarkdownHeadings(raw);
    const text = normalizeText(raw);

    if (text.length === 0) {
      throw new ParseError('EMPTY_CONTENT', 'That file contains no readable text.');
    }

    return {
      text,
      pages: [{ pageNumber: 1, text }],
      // Offsets are recomputed against the normalized text: the chunker slices
      // that string, so an offset into the raw one would point at the wrong
      // character the moment whitespace collapsed.
      headings: relocateHeadings(headings, text),
      metadata: {
        pageCount: 1,
        ...(headings[0]?.level === 1 ? { title: headings[0].text } : {}),
      },
    };
  }
}

function extractMarkdownHeadings(raw: string): ParsedHeading[] {
  const headings: ParsedHeading[] = [];
  let inFence = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    // ``` or ~~~ toggles a fenced block. Both delimiters are legal CommonMark
    // and both appear in real documents.
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (match?.[1] && match[2]) {
      headings.push({ level: match[1].length, text: match[2].trim(), charOffset: 0 });
    }
  }

  return headings;
}

/**
 * Finds each heading's offset in the normalized text.
 *
 * Searched forward from the previous match so a heading whose text repeats —
 * "Overview" under three different parents — resolves to its own occurrence
 * rather than always to the first.
 */
function relocateHeadings(headings: ParsedHeading[], text: string): ParsedHeading[] {
  let cursor = 0;
  const located: ParsedHeading[] = [];

  for (const heading of headings) {
    const index = text.indexOf(heading.text, cursor);
    if (index === -1) continue;
    located.push({ ...heading, charOffset: index });
    cursor = index + heading.text.length;
  }

  return located;
}

export { decode as decodeText, estimateTokens };
