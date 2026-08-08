import { randomUUID } from 'node:crypto';
import { API_PREFIX, request } from '../helpers/app.js';
import { db } from '../helpers/database.js';
import type { DocumentDto, DocumentStatus } from '@lumora/shared';

/**
 * Minimal but genuine file bodies.
 *
 * Real signatures, not `Buffer.from('fake pdf')`. Validation sniffs magic
 * bytes, so a fixture without a real header would exercise the rejection path
 * while claiming to test the happy one — the test would pass and prove the
 * opposite of what it says.
 */
export const FIXTURES = {
  /** `%PDF-1.4` plus a minimal trailer — enough for `file-type`. */
  pdf: (): Buffer =>
    Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
      'latin1',
    ),

  text: (body = 'Lumora test document.\nSecond line.\n'): Buffer => Buffer.from(body, 'utf8'),

  markdown: (body = '# Heading\n\nSome prose.\n'): Buffer => Buffer.from(body, 'utf8'),

  /** A PNG header — used to prove an extension mismatch is caught. */
  png: (): Buffer =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 1),
    ]),

  /** A ZIP that is not a Word document. */
  zip: (): Buffer =>
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0)]),
} as const;

/** A unique name per call, so no test depends on another's fixture. */
export function uniqueFilename(extension = '.txt'): string {
  return `doc-${randomUUID().slice(0, 8)}${extension}`;
}

export interface UploadOptions {
  filename?: string;
  bytes?: Buffer;
  contentType?: string;
}

/**
 * Uploads through the real endpoint.
 *
 * Deliberately not a row insert. Going through `POST /documents` means every
 * document a test works with was produced the way a real one is — validated,
 * hashed, stored, and enqueued — so a test built on it cannot keep passing
 * after the upload path breaks.
 */
export async function uploadDocument(
  accessToken: string,
  options: UploadOptions = {},
): Promise<DocumentDto> {
  const filename = options.filename ?? uniqueFilename();
  const bytes = options.bytes ?? FIXTURES.text(`Unique body ${randomUUID()}\n`);

  const response = await request()
    .post(`${API_PREFIX}/documents`)
    .set('Authorization', `Bearer ${accessToken}`)
    .attach('files', bytes, { filename, contentType: options.contentType ?? 'text/plain' });

  if (response.status !== 202) {
    throw new Error(
      `uploadDocument: expected 202, got ${String(response.status)} — ${JSON.stringify(response.body)}`,
    );
  }

  const accepted = (response.body as { accepted: DocumentDto[] }).accepted[0];
  if (!accepted) {
    throw new Error(`uploadDocument: file rejected — ${JSON.stringify(response.body)}`);
  }

  return accepted;
}

/**
 * Forces a document into a status the API cannot reach yet.
 *
 * There is no worker in M3, so `queued` is the only status an upload
 * produces. Listing and filtering still have to work across the whole enum
 * FR-13 shows to users, and this is the only way to exercise it without
 * inventing a worker to satisfy a test.
 */
export async function setDocumentStatus(
  documentId: string,
  status: DocumentStatus,
  failure?: { code: string; message: string },
): Promise<void> {
  await db
    .updateTable('documents')
    .set({
      status,
      error_code: failure?.code ?? null,
      error_message: failure?.message ?? null,
    })
    .where('id', '=', documentId)
    .execute();
}

/** The stored row, for asserting on fields the DTO deliberately hides. */
export async function readDocumentRow(documentId: string): Promise<{
  storageKey: string;
  contentHash: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  userId: string;
}> {
  const row = await db
    .selectFrom('documents')
    .select([
      'storage_key',
      'content_hash',
      'original_name',
      'mime_type',
      'size_bytes',
      'user_id',
    ])
    .where('id', '=', documentId)
    .executeTakeFirstOrThrow();

  return {
    storageKey: row.storage_key,
    contentHash: row.content_hash,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    userId: row.user_id,
  };
}
