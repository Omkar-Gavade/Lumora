/** FR-13: the status sequence shown to users, verbatim. */
export type DocumentStatus =
  | 'queued'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'failed';

/**
 * A document as the API represents it.
 *
 * A projection of the row, not the row. `storage_key` and `content_hash` are
 * deliberately absent: the key is an internal storage address that no client
 * needs, and the hash would let one user probe whether another has a
 * particular file by uploading it and observing the dedup response.
 */
export interface DocumentDto {
  id: string;
  /** Sanitized display name. */
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  /** Machine code the frontend maps to copy; `null` unless status is failed. */
  errorCode: string | null;
  /** FR-13: the human-readable reason. */
  errorMessage: string | null;
  pageCount: number | null;
  chunkCount: number;
  createdAt: string;
  processedAt: string | null;
}

/** docs/04-data-and-api.md §2: cursor pagination, never offset. */
export interface DocumentListDto {
  items: DocumentDto[];
  /** Opaque; pass back as `?cursor=`. `null` when there is no further page. */
  nextCursor: string | null;
}

/** FR-16 / the sidebar meter. */
export interface StorageUsageDto {
  usedBytes: number;
  limitBytes: number;
  documentCount: number;
  documentLimit: number;
}

/**
 * `POST /documents` answers 202, not 201: the rows exist but the work has not
 * happened. Per-file outcomes are reported individually because one rejected
 * file in a batch of five must not fail the other four.
 */
export interface UploadResultDto {
  accepted: DocumentDto[];
  rejected: { filename: string; code: string; message: string }[];
}
