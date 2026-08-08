/**
 * One page of extracted text.
 *
 * Page numbers survive extraction because they are what a citation points at
 * (docs/05-rag-and-chat.md §2.3). Formats with no pagination report a single
 * page numbered 1 rather than omitting the field — a nullable page number
 * would push the same branch into every downstream consumer.
 */
export interface ParsedPage {
  pageNumber: number;
  text: string;
}

/**
 * A heading discovered during extraction.
 *
 * Captured here rather than inferred later because only the parser can see the
 * signal: font size and weight in a PDF, real heading levels in DOCX, `#`
 * depth in Markdown. By the time text is a flat string that information is
 * gone, and the chunker would be guessing from line breaks.
 */
export interface ParsedHeading {
  level: number;
  text: string;
  /** Offset into the normalized full text, so the chunker can locate it. */
  charOffset: number;
}

export interface ParsedDocument {
  /** Normalized full text — every page joined, in order. */
  text: string;
  pages: ParsedPage[];
  headings: ParsedHeading[];
  metadata: {
    /** Pages for paginated formats; 1 otherwise. */
    pageCount: number;
    /** Producer-reported title, when the format carries one. */
    title?: string | undefined;
    author?: string | undefined;
  };
}

/**
 * Format-specific extraction, behind one interface
 * (docs/05-rag-and-chat.md §2.2).
 *
 * A parser's only job is bytes → `{ text, pages, structure, metadata }`. It
 * does not chunk, does not embed, and does not touch the database — which is
 * what lets every parser be tested against a fixture file with no server, no
 * queue, and no provider.
 */
export interface DocumentParser {
  /** Provider name, for logs. */
  readonly name: string;
  /** The MIME types this parser claims. */
  readonly supports: readonly string[];
  parse(bytes: Buffer): Promise<ParsedDocument>;
}

/**
 * Raised when a document cannot be extracted — and carries a **code**, not
 * just a message.
 *
 * FR-13 requires a human-readable failure reason on the document row, and
 * docs/00-product.md §160 names the exact one that matters: a scanned PDF must
 * fail with "This PDF has no extractable text — it looks like a scanned
 * image. OCR is not supported yet," not a generic error. The code is what the
 * pipeline persists and the frontend maps; the message is what the user reads.
 *
 * `retryable` is the other half. A password-protected PDF will be
 * password-protected on every attempt, so retrying spends the job's budget to
 * reach the same conclusion three times and delays the failure the user is
 * waiting to see.
 */
export class ParseError extends Error {
  constructor(
    readonly code: ParseErrorCode,
    message: string,
    readonly retryable = false,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ParseError';
    this.cause = cause;
  }
}

export type ParseErrorCode =
  /** A PDF whose text layer is missing or negligible — almost always a scan. */
  | 'NO_TEXT_LAYER'
  /** The bytes are not the format they claimed, or are truncated. */
  | 'CORRUPT_FILE'
  /** Encrypted or password-protected. */
  | 'ENCRYPTED_FILE'
  /** Parsed successfully and produced nothing worth indexing. */
  | 'EMPTY_CONTENT'
  /** No parser claims this MIME type. */
  | 'UNSUPPORTED_FORMAT';
