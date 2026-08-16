import type { DocumentDto, DocumentStatus } from '@lumora/shared';

/**
 * A document as the domain sees it.
 *
 * Sits between the row and the DTO. `storageKey` and `contentHash` live here
 * because services genuinely need them — deletion addresses the bytes by key,
 * dedup compares hashes — and are absent from `DocumentDto`, which is what
 * makes leaking either a compile error rather than a review catch.
 *
 * `contentHash` in particular must not reach a client: it would let one user
 * probe whether another holds a given file by uploading it and watching for a
 * dedup response.
 */
export interface Document {
  id: string;
  userId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  storageKey: string;
  status: DocumentStatus;
  errorCode: string | null;
  errorMessage: string | null;
  pageCount: number | null;
  /** The planned total the chunker produced. A column; see the repository. */
  chunkCount: number;
  /**
   * Not columns. Counted from `document_chunks` on every read, because the
   * authoritative record of "this chunk exists" and "this chunk has a vector"
   * is the row itself and its `vector_id` — the same fields the resume path
   * reads to decide what still needs embedding. Mirrored counters on
   * `documents` would be a second source of truth for facts the rows already
   * carry, and they would disagree the first time a worker died between
   * writing vectors and updating the tally.
   */
  writtenChunkCount: number;
  embeddedChunkCount: number;
  tokenCount: number | null;
  embeddingModel: string | null;
  embeddingDims: number | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The single place a `Document` becomes something a client may see. */
export function toDocumentDto(document: Document): DocumentDto {
  return {
    id: document.id,
    filename: document.filename,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    status: document.status,
    errorCode: document.errorCode,
    errorMessage: document.errorMessage,
    pageCount: document.pageCount,
    chunkCount: document.chunkCount,
    writtenChunkCount: document.writtenChunkCount,
    embeddedChunkCount: document.embeddedChunkCount,
    createdAt: document.createdAt.toISOString(),
    processedAt: document.processedAt?.toISOString() ?? null,
  };
}
