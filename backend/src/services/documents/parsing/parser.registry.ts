import { DocxParser } from './docx.parser.js';
import { ParseError, type DocumentParser } from './parser.interface.js';
import { PdfParser } from './pdf.parser.js';
import { MarkdownParser, TextParser } from './text.parser.js';

/**
 * MIME type → parser (docs/05-rag-and-chat.md §2.1, "Inspect").
 *
 * Dispatch is on the **sniffed** MIME type the upload validator already
 * recorded, never on the filename. By the time a document reaches this table
 * its bytes have been checked against its extension, so a `.pdf` that is really
 * a zip was rejected at upload rather than reaching a parser that would open it
 * as something it is not.
 *
 * Parsers are instantiated once. All four are stateless, and the heavy
 * dependencies they need are loaded inside `parse`, so construction costs
 * nothing.
 */
const PARSERS: readonly DocumentParser[] = [
  new PdfParser(),
  new DocxParser(),
  new MarkdownParser(),
  new TextParser(),
];

const BY_MIME_TYPE = new Map<string, DocumentParser>(
  PARSERS.flatMap((parser) => parser.supports.map((mime) => [mime, parser] as const)),
);

/**
 * Returns the parser for a MIME type, or `null`.
 *
 * Separate from `parserFor` so the pipeline can check support before pulling a
 * file out of storage — there is no reason to download 25 MB to discover
 * nothing can read it.
 */
export function findParser(mimeType: string): DocumentParser | null {
  return BY_MIME_TYPE.get(mimeType) ?? null;
}

/**
 * Returns the parser for a MIME type, or throws `UNSUPPORTED_FORMAT`.
 *
 * Reaching this throw means a type passed upload validation that no parser
 * claims — the two lists have drifted. Failing loudly with a coded error puts
 * that on the document row and in the logs, rather than leaving the document
 * stuck in `queued` with nothing to explain it.
 */
export function parserFor(mimeType: string): DocumentParser {
  const parser = findParser(mimeType);

  if (parser === null) {
    throw new ParseError(
      'UNSUPPORTED_FORMAT',
      'This file type is not supported yet.',
      false,
    );
  }

  return parser;
}

/** Every MIME type some parser claims — asserted against the accepted list. */
export function supportedMimeTypes(): string[] {
  return [...BY_MIME_TYPE.keys()].sort();
}
