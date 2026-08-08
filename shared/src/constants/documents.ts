/**
 * Upload limits and accepted formats — FR-12 and FR-16.
 *
 * Shared so the dropzone rejects a file before spending a minute uploading it,
 * and the server rejects the same file if the client is bypassed. Two copies
 * of these numbers would drift, and the drift shows up as a browser that
 * accepts a file the API refuses.
 */

/** FR-12: PDF, DOCX, TXT, MD. Everything else is FR-19 / Phase 2. */
export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
] as const;

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

/**
 * Extension → the MIME type the bytes must actually turn out to be.
 *
 * Used for the dropzone's `accept` attribute and to reject a mismatch between
 * the declared extension and the sniffed format. Markdown and plain text share
 * a magic signature (they have none), so both map to a text family checked
 * separately.
 */
export const ACCEPTED_EXTENSIONS: Record<string, AcceptedMimeType> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
};

/** FR-16: per-file cap. 25 MB holds a large scanned-free PDF comfortably. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** docs/04-data-and-api.md §2.3: "multipart, ≤5 files". */
export const MAX_FILES_PER_UPLOAD = 5;

/** FR-16: total bytes cap per user. */
export const MAX_TOTAL_BYTES_PER_USER = 5 * 1024 * 1024 * 1024;

/** FR-16: file count cap per user. */
export const MAX_DOCUMENTS_PER_USER = 500;

/** Display name cap. Long enough for a real filename, bounded for a column. */
export const MAX_FILENAME_LENGTH = 255;
