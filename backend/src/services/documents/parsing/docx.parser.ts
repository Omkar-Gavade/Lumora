import { normalizeText } from './normalize.js';
import {
  ParseError,
  type DocumentParser,
  type ParsedDocument,
  type ParsedHeading,
} from './parser.interface.js';

/**
 * DOCX extraction via `mammoth` (docs/05-rag-and-chat.md §2.2).
 *
 * §2.2 wants "real heading levels" out of DOCX, which rules out
 * `extractRawText` — that returns a flat string and throws away the one piece
 * of structure this format hands over for free. `convertToHtml` maps Word's
 * built-in Heading 1–6 styles onto `<h1>`–`<h6>`, so the heading tree survives
 * as markup that can be read back out.
 *
 * `convertToMarkdown` would be the shorter route, but mammoth ships it as
 * experimental and it escapes inline characters — a document containing
 * `cost_basis` comes back as `cost\_basis`, and those backslashes then end up
 * embedded in a chunk and searched against.
 *
 * Imported dynamically for the same reason as pdfjs: the API server imports
 * this module transitively and never parses a DOCX.
 */
export class DocxParser implements DocumentParser {
  readonly name = 'docx';
  readonly supports = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ] as const;

  async parse(bytes: Buffer): Promise<ParsedDocument> {
    const mammoth = await import('mammoth');

    let html: string;
    try {
      const result = await mammoth.convertToHtml({ buffer: bytes });
      html = result.value;
    } catch (error) {
      throw toParseError(error);
    }

    const extracted = extractFromHtml(html);
    const text = normalizeText(extracted.text);

    if (text.length === 0) {
      throw new ParseError(
        'EMPTY_CONTENT',
        'This document contains no readable text.',
      );
    }

    return {
      text,
      // DOCX has no fixed pagination — page breaks are computed by the renderer
      // from fonts and margins, and mammoth does not expose them. Reporting one
      // page is the honest answer; inventing page numbers would produce
      // citations that point at nothing.
      pages: [{ pageNumber: 1, text }],
      headings: relocateHeadings(extracted.headings, text),
      metadata: {
        pageCount: 1,
        ...(extracted.headings[0]?.level === 1
          ? { title: extracted.headings[0].text }
          : {}),
      },
    };
  }
}

interface HtmlExtraction {
  text: string;
  headings: ParsedHeading[];
}

/** Block-level tags whose boundaries become line breaks in the output. */
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'td', 'th', 'br']);

/**
 * Reads text and headings out of mammoth's HTML.
 *
 * Hand-written rather than delegated to an HTML parser because mammoth emits a
 * closed, known vocabulary — `p`, `h1`–`h6`, `ul`/`ol`/`li`, `table`/`tr`/`td`,
 * `strong`, `em`, `a`, `br`, `img` — with no scripts, no attributes worth
 * reading, and no malformed markup. A DOM library would be a dependency and a
 * parse of arbitrary HTML to answer a question about generated HTML.
 *
 * The scan is a single pass over tags rather than a regex per construct, which
 * is what keeps heading text and body text in the same stream: a heading's
 * `charOffset` has to be an offset into the very text the chunker will slice,
 * and matching headings separately would leave those offsets to be guessed.
 */
function extractFromHtml(html: string): HtmlExtraction {
  const headings: ParsedHeading[] = [];
  let text = '';
  let cursor = 0;
  /** Non-null while inside `<h1>`–`<h6>`: the level and where its text began. */
  let openHeading: { level: number; start: number } | null = null;

  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let match: RegExpExecArray | null;

  const appendBlockBreak = (): void => {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  };

  while ((match = tagPattern.exec(html)) !== null) {
    text += decodeEntities(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const tag = (match[1] ?? '').toLowerCase();
    const isClosing = match[0].startsWith('</');

    if (!BLOCK_TAGS.has(tag)) continue;

    const headingLevel = /^h([1-6])$/.exec(tag);

    if (headingLevel?.[1] !== undefined && !isClosing) {
      appendBlockBreak();
      openHeading = { level: Number(headingLevel[1]), start: text.length };
      continue;
    }

    if (headingLevel && isClosing && openHeading) {
      const headingText = text.slice(openHeading.start).trim();
      if (headingText.length > 0) {
        headings.push({
          level: openHeading.level,
          text: headingText,
          charOffset: openHeading.start,
        });
      }
      openHeading = null;
    }

    // A block boundary is a paragraph break. Two newlines, because the
    // normalizer treats a single one as a soft wrap and collapses it — and
    // paragraph structure is what the chunker splits on.
    if (isClosing || tag === 'br') {
      appendBlockBreak();
      text += '\n';
    }
  }

  text += decodeEntities(html.slice(cursor));

  return { text, headings };
}

/**
 * Decodes the entities mammoth actually emits.
 *
 * It escapes exactly these five when writing HTML, so a general entity table
 * would be dead code. `&amp;` is resolved last: decoding it first would turn
 * a literal `&amp;lt;` in the source document into `<`.
 */
function decodeEntities(fragment: string): string {
  return fragment
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Re-anchors heading offsets against the normalized text.
 *
 * Normalization collapses whitespace, so every offset taken from the raw
 * extraction shifts left by an unpredictable amount. Searching forward from the
 * previous heading keeps repeated titles ("Summary" under three sections)
 * pointing at their own occurrence.
 */
function relocateHeadings(headings: ParsedHeading[], text: string): ParsedHeading[] {
  let cursor = 0;
  const located: ParsedHeading[] = [];

  for (const heading of headings) {
    const needle = normalizeText(heading.text);
    const index = needle.length > 0 ? text.indexOf(needle, cursor) : -1;
    if (index === -1) continue;
    located.push({ level: heading.level, text: needle, charOffset: index });
    cursor = index + needle.length;
  }

  return located;
}

/**
 * Classifies mammoth failures.
 *
 * A DOCX is a zip; the two ways it fails to open are "not a zip" (wrong bytes,
 * truncated upload) and "a zip without the Word parts" (a renamed .xlsx, an
 * OpenDocument file). Both are permanent — the bytes will not become a
 * different format on the second attempt — so neither is worth a retry.
 */
function toParseError(error: unknown): ParseError {
  const message = error instanceof Error ? error.message : String(error);

  // Password-protected Office files are CFB containers, not zips. mammoth sees
  // an invalid archive, so the distinct message is the only signal.
  if (/encrypt|password/i.test(message)) {
    return new ParseError(
      'ENCRYPTED_FILE',
      'This document is password-protected. Remove the password and upload it again.',
      false,
      error,
    );
  }

  return new ParseError(
    'CORRUPT_FILE',
    'This document could not be opened — the file may be damaged or may not be a real .docx file.',
    false,
    error,
  );
}
