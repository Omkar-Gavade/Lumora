import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
  MAX_DOCUMENTS_PER_USER,
  MAX_TOTAL_BYTES_PER_USER,
  type DocumentDto,
  type DocumentListDto,
  type DocumentStatus,
  type StorageUsageDto,
  type UploadResultDto,
} from '@lumora/shared';
import { env } from '../../config/index.js';
import { db } from '../../db/pool.js';
import { toDocumentDto, type Document } from '../../domain/entities/document.js';
import { JOB_TYPES } from '../../domain/jobs/job-types.js';
import { ConflictError, NotFoundError, QuotaExceededError } from '../../domain/errors/index.js';
import { logger } from '../../lib/logger.js';
import { documentRepository } from '../../repositories/document.repository.js';
import { jobRepository } from '../../repositories/job.repository.js';
import { storageProvider } from '../../providers/storage/storage.factory.js';
import { vectorStore } from '../../providers/vector/vector.factory.js';
import { collectionFor } from '../../providers/vector/vector-store.interface.js';
import { validateUpload } from './upload-validation.js';

/** One file as multer hands it over. */
export interface IncomingFile {
  originalname: string;
  buffer: Buffer;
}

/**
 * Orchestrates the document platform.
 *
 * Owns no SQL and no HTTP (docs/03-backend.md §1) — it composes the
 * repository, the storage provider, and the job queue, and enforces the rules
 * that sit between them.
 */
export const documentService = {
  /**
   * docs/05-rag-and-chat.md §2.1: validate → hash → store bytes → enqueue.
   *
   * Files are processed one at a time and failures are collected rather than
   * thrown: §2.3 permits five per request, and one unreadable file must not
   * discard four good ones the user just waited to upload.
   */
  async upload(userId: string, files: IncomingFile[]): Promise<UploadResultDto> {
    const accepted: DocumentDto[] = [];
    const rejected: UploadResultDto['rejected'] = [];

    for (const file of files) {
      try {
        const outcome = await this.ingestOne(userId, file);
        if (outcome.ok) accepted.push(outcome.document);
        else rejected.push(outcome.rejection);
      } catch (error) {
        // A quota failure ends the batch — every remaining file would hit the
        // same wall, and reporting it five times is noise.
        if (error instanceof QuotaExceededError) throw error;

        logger.error({ err: error, userId, filename: file.originalname }, 'Upload failed');
        rejected.push({
          filename: file.originalname,
          code: 'STORAGE_FAILURE',
          message: 'We could not store that file. Please try again.',
        });
      }
    }

    return { accepted, rejected };
  },

  async ingestOne(
    userId: string,
    file: IncomingFile,
  ): Promise<
    | { ok: true; document: DocumentDto }
    | { ok: false; rejection: UploadResultDto['rejected'][number] }
  > {
    const validation = await validateUpload(file.originalname, file.buffer);

    if (!validation.ok) {
      return {
        ok: false,
        rejection: {
          filename: file.originalname,
          code: validation.code,
          message: validation.message,
        },
      };
    }

    /*
      SHA-256 of the bytes serves two purposes (docs/05 §2.1): the same file
      twice returns the existing document instead of paying to embed it again,
      and a retried job is provably operating on the same input.
    */
    const contentHash = createHash('sha256').update(file.buffer).digest('hex');

    const existing = await documentRepository.findByContentHash(userId, contentHash);
    if (existing) {
      // Idempotent, not an error: re-uploading a file you already have is a
      // reasonable thing to do, and a 409 would make the dropzone show a
      // failure for a document that is present and working.
      logger.info({ userId, documentId: existing.id }, 'Upload deduplicated by content hash');
      return { ok: true, document: toDocumentDto(existing) };
    }

    await this.assertWithinQuota(userId, file.buffer.length);

    /*
      The storage key is generated here and never derived from the filename.
      That is what makes path traversal structurally impossible rather than
      something a sanitizer has to catch — there is no user input in the
      address at all. The user prefix keeps one account's files together, so
      deleting an account is a directory removal instead of a scan.
    */
    const storageKey = `${userId}/${randomUUID()}${extname(validation.filename).toLowerCase()}`;

    await storageProvider.put(storageKey, file.buffer, { contentType: validation.mimeType });

    try {
      /*
        The row and its job are written in ONE transaction.

        docs/05 §2.1 is explicit: "enqueueing outside the transaction produces
        either orphan jobs referencing rows that were rolled back, or documents
        that are never processed. Same transaction, both or neither."
      */
      const document = await db.transaction().execute(async (trx) => {
        const created = await documentRepository.create(
          {
            userId,
            filename: validation.filename,
            originalName: file.originalname,
            mimeType: validation.mimeType,
            sizeBytes: file.buffer.length,
            contentHash,
            storageKey,
          },
          trx,
        );

        await jobRepository.enqueue(
          JOB_TYPES.INGEST_DOCUMENT,
          { documentId: created.id, userId },
          trx,
        );

        return created;
      });

      logger.info(
        { userId, documentId: document.id, sizeBytes: document.sizeBytes },
        'Document uploaded and queued',
      );

      return { ok: true, document: toDocumentDto(document) };
    } catch (error) {
      /*
        The bytes were written before the transaction, so a failed insert
        leaves an object nothing references. Removing it here keeps storage
        from accumulating garbage that no row will ever point at — and the
        delete is idempotent, so this cannot itself fail the request.
      */
      await storageProvider.delete(storageKey).catch((cleanupError: unknown) => {
        logger.error({ err: cleanupError, storageKey }, 'Orphaned object cleanup failed');
      });
      throw error;
    }
  },

  /**
   * FR-16: per-user file count and total bytes, enforced server-side.
   *
   * Checked before the write rather than after, so a user over quota is told
   * before the bytes are stored — and the storage never holds data the account
   * is not entitled to keep.
   */
  async assertWithinQuota(userId: string, incomingBytes: number): Promise<void> {
    const usage = await documentRepository.usageFor(userId);

    if (usage.documentCount >= MAX_DOCUMENTS_PER_USER) {
      throw new QuotaExceededError(
        `You have reached the limit of ${String(MAX_DOCUMENTS_PER_USER)} documents. Delete something to make room.`,
      );
    }

    if (usage.usedBytes + incomingBytes > MAX_TOTAL_BYTES_PER_USER) {
      throw new QuotaExceededError(
        'That upload would exceed your storage limit. Delete something to make room.',
      );
    }
  },

  async list(
    userId: string,
    options: { limit: number; cursor?: string | undefined; status?: DocumentStatus | undefined },
  ): Promise<DocumentListDto> {
    const page = await documentRepository.list(userId, options);
    return { items: page.items.map(toDocumentDto), nextCursor: page.nextCursor };
  },

  async getById(userId: string, documentId: string): Promise<DocumentDto> {
    return toDocumentDto(await this.requireOwned(userId, documentId));
  },

  /**
   * FR-15: deletion removes rows and bytes, completely. There is no soft
   * delete — docs/04-data-and-api.md §1.2: "a `deleted_at` column that retains
   * content contradicts the privacy promise".
   *
   * The row goes first. If the object removal then fails, the user sees the
   * document gone — which is what they asked for and what the privacy promise
   * says — and an orphaned object is logged for a sweeper. The reverse order
   * would leave a row pointing at bytes that no longer exist, so the document
   * would appear in the list and fail on every read.
   *
   * Vector removal joins this in M4; the chunks and vectors do not exist yet.
   */
  /**
   * Deletes a document: rows, bytes, **and vectors**
   * (docs/04-data-and-api.md §2.3).
   *
   * docs/04 §1.2 is explicit that there are no soft deletes — "a `deleted_at`
   * column that retains content contradicts the privacy promise". Chunk rows
   * go with the document by `ON DELETE CASCADE`; the vector store is a
   * separate system and has to be told.
   *
   * The row is deleted first, then the derived copies. That ordering is
   * deliberate: the row is the source of truth, so removing it is what makes
   * the document gone as far as the product is concerned. A leftover vector or
   * an orphan file is a cleanup failure that is logged and can be swept; a row
   * that survives because a vector delete failed is a document the user asked
   * to delete and can still see.
   *
   * Neither cleanup failure is rethrown, for that reason — but both are logged
   * at `error`, because nothing else will crash to draw attention to them.
   */
  async delete(userId: string, documentId: string): Promise<void> {
    const deleted = await documentRepository.deleteById(documentId, userId);
    if (!deleted) throw new NotFoundError('That document does not exist.');

    try {
      await vectorStore.deleteByDocument(
        collectionFor(userId, env.CHROMA_COLLECTION_PREFIX),
        documentId,
      );
    } catch (error) {
      logger.error(
        { err: error, userId, documentId },
        'Document deleted but its vectors remain in the index',
      );
    }

    try {
      await storageProvider.delete(deleted.storageKey);
    } catch (error) {
      logger.error(
        { err: error, userId, documentId, storageKey: deleted.storageKey },
        'Document row deleted but its bytes remain',
      );
    }

    logger.info({ userId, documentId }, 'Document deleted');
  },

  /**
   * Re-enqueues a document for processing (`POST /documents/:id/retry`,
   * docs/04-data-and-api.md §2.3).
   *
   * Only from `failed`. A document mid-pipeline already has a job — either
   * running or waiting on a backoff — and enqueueing a second one would put
   * two workers on the same document, which the guarded status transitions
   * survive but which wastes an embedding run to prove it.
   *
   * The reset is deliberately partial. Status goes back to `queued` and the
   * error is cleared, but **chunks are left in place**: the pipeline is
   * convergent, so a retry re-chunks over them idempotently, and any chunk that
   * already has a vector is skipped by the resume query rather than paid for
   * twice. Deleting them would throw away work that is still valid — a
   * document that failed at embedding call 400 of 500 keeps its 400.
   */
  async retry(userId: string, documentId: string): Promise<DocumentDto> {
    const document = await documentRepository.findById(documentId, userId);
    if (!document) throw new NotFoundError('That document does not exist.');

    if (document.status !== 'failed') {
      throw new ConflictError('That document is not in a failed state.');
    }

    const requeued = await db.transaction().execute(async (trx) => {
      /*
        Guarded on `failed` inside the transaction, so two retry requests
        arriving together enqueue one job rather than two. The second finds no
        row matching the guard.
      */
      const reset = await documentRepository.transitionStatusFromFailed(
        documentId,
        userId,
        'queued',
        trx,
      );
      if (!reset) return null;

      // Same transaction as the status reset — the invariant from
      // docs/05-rag-and-chat.md §2.1: both or neither.
      await jobRepository.enqueue(
        JOB_TYPES.INGEST_DOCUMENT,
        { documentId, userId },
        trx,
      );

      return reset;
    });

    if (!requeued) throw new ConflictError('That document is not in a failed state.');

    logger.info({ userId, documentId }, 'Document re-enqueued');

    return toDocumentDto(requeued);
  },

  /** FR-16 / the sidebar meter. */
  async usageFor(userId: string): Promise<StorageUsageDto> {
    const usage = await documentRepository.usageFor(userId);

    return {
      usedBytes: usage.usedBytes,
      limitBytes: MAX_TOTAL_BYTES_PER_USER,
      documentCount: usage.documentCount,
      documentLimit: MAX_DOCUMENTS_PER_USER,
    };
  },

  /**
   * Loads a document or raises 404.
   *
   * `NotFoundError`, never `ForbiddenError` — a 403 on someone else's id
   * confirms the id is real, which is exactly what an IDOR probe is looking
   * for. The repository scopes by owner, so the miss arrives here naturally.
   */
  async requireOwned(userId: string, documentId: string): Promise<Document> {
    const document = await documentRepository.findById(documentId, userId);
    if (!document) throw new NotFoundError('That document does not exist.');
    return document;
  },
};
