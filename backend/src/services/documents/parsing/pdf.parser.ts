import { normalizePages, normalizeText } from './normalize.js';
import {
  ParseError,
  type DocumentParser,
  type ParsedDocument,
  type ParsedPage,
} from './parser.interface.js';

/**
 * Below this many characters per page, a PDF is treated as a scan.
 *
 * docs/05-rag-and-chat.md §2.2: "If extracted text is below a threshold
 * relative to page count, the document is almost certainly a scan: fail with
 * the explicit `NO_TEXT_LAYER` reason rather than silently indexing 40 pages
 * of whitespace and later abstaining on every question."
 *
 * The second half is what makes this worth a threshold rather than a
 * zero-check. A scanned PDF is not empty — it carries stray characters from
 * stamps, page numbers, and OCR-less form fields. Accepting it produces a
 * document that reports `ready`, contains nothing, and abstains on every
 * question the user asks it, with no indication why.
 *
 * 50 is deliberately low. A genuine title page or a chapter divider can be
 * nearly bare, and rejecting a real document is worse than accepting a
 * marginal one — the aim is to catch the wholly-image PDF, not to grade text
 * density.
 */
const MIN_CHARS_PER_PAGE = 50;

/**
 * PDF extraction via `pdfjs-dist` (docs/05-rag-and-chat.md §2.2).
 *
 * The **legacy** build is imported deliberately: the default entry point
 * targets browsers and reaches for DOM APIs that do not exist in Node, failing
 * at import rather than at parse. The legacy build is the one Mozilla ships for
 * exactly this.
 *
 * Loaded dynamically rather than at module scope so the cost — a few megabytes
 * of parser and font data — is paid by the worker that actually opens a PDF,
 * not by every process that imports the pipeline, including the API server
 * that never parses anything.
 */
export class PdfParser implements DocumentParser {
  readonly name = 'pdf';
  readonly supports = ['application/pdf'] as const;

  async parse(bytes: Buffer): Promise<ParsedDocument> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    let document;
    try {
      document = await pdfjs.getDocument({
        // A copy, because pdfjs transfers ownership of the buffer it is given
        // and will detach it — leaving the caller holding an empty view if the
        // same bytes are needed again (a retry, a hash check).
        data: new Uint8Array(bytes),
        // Both off: this is a server, there is nothing to render, and font
        // loading is the slowest part of opening a document whose glyphs
        // nobody will draw.
        disableFontFace: true,
        // Suppresses pdfjs' own console output, which bypasses the logger's
        // redaction and would print document content on a malformed file.
        verbosity: 0,
      }).promise;
    } catch (error) {
      throw toParseError(error);
    }

    try {
      const pages: ParsedPage[] = [];

      // Sequential, not `Promise.all`. Page extraction allocates the page's
      // content stream and its fonts; a 200-page document parsed in parallel
      // holds all 200 at once, and the memory ceiling is what kills a worker
      // handling several documents concurrently.
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          pages.push({ pageNumber, text: joinTextItems(content.items) });
        } finally {
          // Releases the page's operator list and fonts immediately rather
          // than at document teardown.
          page.cleanup();
        }
      }

      const normalized = normalizePages(pages);
      const text = normalizeText(normalized.map((page) => page.text).join('\n\n'));

      /*
        The scan check runs against the *whole* document rather than per page.
        A report with three image-only figure pages among forty of prose is a
        perfectly good document; only the aggregate distinguishes a scan.
      */
      if (text.length < document.numPages * MIN_CHARS_PER_PAGE) {
        throw new ParseError(
          'NO_TEXT_LAYER',
          'This PDF has no extractable text — it looks like a scanned image. OCR is not supported yet.',
        );
      }

      return {
        text,
        pages: normalized,
        // Heading inference from font size and weight (§2.2) belongs with the
        // chunker that consumes it and is not implemented here. An empty list
        // is honest; a guess from line breaks would be worse than nothing,
        // because the section path is prepended to every chunk's embedded
        // text and a wrong path actively misleads retrieval.
        headings: [],
        metadata: { pageCount: document.numPages },
      };
    } finally {
      // Frees the worker and its buffers. Without it a long-running process
      // leaks a document's worth of memory per parse.
      await document.destroy();
    }
  }
}

/**
 * Joins pdfjs text items into lines.
 *
 * pdfjs emits positioned fragments, not lines: `hasEOL` is the only signal for
 * where a visual line ended. Concatenating without it produces one unbroken
 * string, which destroys the paragraph structure the chunker splits on and
 * makes de-hyphenation impossible — there are no line breaks left to rejoin
 * across.
 */
function joinTextItems(items: unknown[]): string {
  let text = '';

  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const fragment = item as { str?: unknown; hasEOL?: unknown };
    if (typeof fragment.str !== 'string') continue;

    text += fragment.str;
    if (fragment.hasEOL === true) text += '\n';
  }

  return text;
}

/**
 * Maps pdfjs failures to codes the pipeline can act on.
 *
 * The distinction that matters is retryability. A password-protected file will
 * be password-protected on every attempt, so retrying spends the job's whole
 * budget to reach the same answer three times — and delays by minutes the
 * failure the user is waiting to see.
 */
function toParseError(error: unknown): ParseError {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);

  if (name === 'PasswordException' || /password/i.test(message)) {
    return new ParseError(
      'ENCRYPTED_FILE',
      'This PDF is password-protected. Remove the password and upload it again.',
      false,
      error,
    );
  }

  if (name === 'InvalidPDFException' || /invalid pdf/i.test(message)) {
    return new ParseError(
      'CORRUPT_FILE',
      'This PDF could not be opened — the file may be damaged.',
      false,
      error,
    );
  }

  // Unknown failures are retryable: an out-of-memory or a transient I/O error
  // during extraction is worth a second attempt, and misclassifying one as
  // permanent loses a document that would have succeeded.
  return new ParseError('CORRUPT_FILE', 'This PDF could not be read.', true, error);
}
