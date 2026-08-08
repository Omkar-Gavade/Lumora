import { describe, expect, it } from 'vitest';
import { ERROR_CODES, MAX_FILES_PER_UPLOAD } from '@lumora/shared';
import { API_PREFIX, request } from '../helpers/app.js';
import { authenticatedRequest } from '../helpers/auth.js';
import { countRows } from '../helpers/database.js';
import { createTestUser, createVerifiedUser } from '../factories/user.factory.js';
import {
  FIXTURES,
  readDocumentRow,
  setDocumentStatus,
  uniqueFilename,
  uploadDocument,
} from '../factories/document.factory.js';
import { expectApiError, expectNoContent } from '../utils/contract.js';
import { storageProvider } from '../../src/providers/storage/storage.factory.js';
import { jobRepository } from '../../src/repositories/job.repository.js';

const DOCUMENTS = `${API_PREFIX}/documents`;

/** Attaches a file to a request under the field the route reads. */
function upload(token: string, filename: string, bytes: Buffer, contentType = 'text/plain') {
  return request()
    .post(DOCUMENTS)
    .set('Authorization', `Bearer ${token}`)
    .attach('files', bytes, { filename, contentType });
}

describe('POST /documents', () => {
  it('accepts a file, stores the bytes, and answers 202', async () => {
    const user = await createVerifiedUser();

    const response = await upload(user.session.accessToken, 'notes.txt', FIXTURES.text()).expect(202);

    // 202, not 201: the row exists and the work has not happened
    // (docs/04-data-and-api.md §2.3).
    expect(response.body.accepted).toHaveLength(1);
    expect(response.body.rejected).toHaveLength(0);

    const document = response.body.accepted[0];
    expect(document).toMatchObject({
      filename: 'notes.txt',
      mimeType: 'text/plain',
      status: 'queued',
      chunkCount: 0,
      errorCode: null,
    });
    expect(document.sizeBytes).toBeGreaterThan(0);

    const row = await readDocumentRow(document.id);
    expect(await storageProvider.exists(row.storageKey)).toBe(true);
  });

  it('records the metadata the pipeline and the UI both need', async () => {
    const user = await createVerifiedUser();
    const bytes = FIXTURES.markdown('# Title\n\nBody.\n');

    const document = await uploadDocument(user.session.accessToken, {
      filename: 'Design Notes.md',
      bytes,
      contentType: 'text/markdown',
    });

    const row = await readDocumentRow(document.id);
    expect(row.originalName).toBe('Design Notes.md');
    expect(row.mimeType).toBe('text/markdown');
    expect(row.sizeBytes).toBe(bytes.length);
    // SHA-256 of the bytes (docs/05-rag-and-chat.md §2.1).
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.userId).toBe(user.id);
  });

  it('enqueues the ingestion job in the same transaction as the row', async () => {
    /*
      docs/05-rag-and-chat.md §2.1: "enqueueing outside the transaction
      produces either orphan jobs referencing rows that were rolled back, or
      documents that are never processed. Same transaction, both or neither."
    */
    const user = await createVerifiedUser();
    expect(await jobRepository.countPending('ingest_document')).toBe(0);

    await uploadDocument(user.session.accessToken);

    expect(await countRows('documents')).toBe(1);
    expect(await jobRepository.countPending('ingest_document')).toBe(1);
  });

  it('sniffs the real format instead of trusting the declared Content-Type', async () => {
    // Both the extension and the client's Content-Type are attacker-
    // controlled (docs/03-backend.md §3).
    const user = await createVerifiedUser();

    const response = await upload(
      user.session.accessToken,
      'invoice.pdf',
      FIXTURES.png(),
      'application/pdf',
    ).expect(202);

    expect(response.body.accepted).toHaveLength(0);
    expect(response.body.rejected[0].code).toBe(ERROR_CODES.FILE_TYPE_MISMATCH);
    expect(await countRows('documents')).toBe(0);
  });

  it('rejects a ZIP wearing a .docx extension', async () => {
    // DOCX is a ZIP, so accepting "it is a ZIP" would let any archive through.
    const user = await createVerifiedUser();

    const response = await upload(
      user.session.accessToken,
      'report.docx',
      FIXTURES.zip(),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ).expect(202);

    expect(response.body.rejected[0].code).toBe(ERROR_CODES.FILE_TYPE_MISMATCH);
  });

  it('rejects an unsupported format', async () => {
    const user = await createVerifiedUser();

    const response = await upload(user.session.accessToken, 'photo.png', FIXTURES.png(), 'image/png').expect(202);

    expect(response.body.rejected[0].code).toBe(ERROR_CODES.UNSUPPORTED_FILE_TYPE);
  });

  it('rejects an empty file', async () => {
    const user = await createVerifiedUser();

    const response = await upload(user.session.accessToken, 'empty.txt', Buffer.alloc(0)).expect(202);

    expect(response.body.rejected[0].code).toBe(ERROR_CODES.EMPTY_FILE);
    expect(await countRows('documents')).toBe(0);
  });

  it('rejects binary content wearing a .txt extension', async () => {
    const user = await createVerifiedUser();
    const binary = Buffer.concat([Buffer.from('text'), Buffer.alloc(64, 0)]);

    const response = await upload(user.session.accessToken, 'notes.txt', binary).expect(202);

    expect(response.body.rejected[0].code).toBe(ERROR_CODES.FILE_TYPE_MISMATCH);
  });

  it('accepts the good files in a mixed batch and reports only the bad ones', async () => {
    // One unreadable file must not discard the others the user just waited to
    // upload (docs/04-data-and-api.md §2.3 allows five per request).
    const user = await createVerifiedUser();

    const response = await request()
      .post(DOCUMENTS)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .attach('files', FIXTURES.text('First.\n'), { filename: 'a.txt' })
      .attach('files', FIXTURES.png(), { filename: 'b.png' })
      .attach('files', FIXTURES.markdown('# C\n'), { filename: 'c.md' })
      .expect(202);

    expect(response.body.accepted).toHaveLength(2);
    expect(response.body.rejected).toHaveLength(1);
    expect(response.body.rejected[0].filename).toBe('b.png');
    expect(await countRows('documents')).toBe(2);
  });

  it('returns the existing document when the same bytes are uploaded twice', async () => {
    // Idempotent, not an error: re-uploading a file you already have is
    // reasonable, and a 409 would show a failure for a working document.
    const user = await createVerifiedUser();
    const bytes = FIXTURES.text('Identical content.\n');

    const first = await uploadDocument(user.session.accessToken, { filename: 'one.txt', bytes });
    const second = await uploadDocument(user.session.accessToken, { filename: 'two.txt', bytes });

    expect(second.id).toBe(first.id);
    expect(await countRows('documents')).toBe(1);
  });

  it('lets two users each own an identical file', async () => {
    // The hash uniqueness is per user. A global constraint would leak the
    // existence of one user's file to another.
    const bytes = FIXTURES.text('Shared public whitepaper.\n');
    const first = await createVerifiedUser();
    const second = await createVerifiedUser();

    await uploadDocument(first.session.accessToken, { bytes });
    await uploadDocument(second.session.accessToken, { bytes });

    expect(await countRows('documents')).toBe(2);
  });

  it('sanitizes a traversal-shaped filename and stores under a generated key', async () => {
    /*
      The display name is cleaned, but the real defence is that the storage key
      is a server-generated UUID — there is no user input in the address at
      all, so traversal has no surface rather than being caught by a filter.
    */
    const user = await createVerifiedUser();

    const document = await uploadDocument(user.session.accessToken, {
      filename: '../../../etc/passwd.txt',
      bytes: FIXTURES.text('not passwd\n'),
    });

    expect(document.filename).toBe('passwd.txt');

    const row = await readDocumentRow(document.id);
    expect(row.storageKey.startsWith(`${user.id}/`)).toBe(true);
    expect(row.storageKey).not.toContain('..');

    /*
      `originalName` is the basename, not the path that was written above.

      A multipart encoder — `form-data` here, and every browser — puts only the
      basename in `Content-Disposition`, so the traversal string never reaches
      the server over this transport. That is worth recording rather than
      asserting away: the sanitizer exists for clients that are *not* browsers,
      which is every client an attacker actually uses.
    */
    expect(row.originalName).toBe('passwd.txt');
  });

  it('sanitizes a traversal path that a non-browser client sends directly', async () => {
    // The case the transport above cannot produce, exercised where the
    // sanitizer actually lives.
    const { sanitizeFilename } = await import('../../src/services/documents/upload-validation.js');

    expect(sanitizeFilename('../../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeFilename('..\\..\\windows\\system32\\config.txt')).toBe('config.txt');
    expect(sanitizeFilename('/absolute/path/report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('....//evil.txt')).toBe('evil.txt');
  });

  it('rejects more files than the documented maximum', async () => {
    const user = await createVerifiedUser();

    let pending = request().post(DOCUMENTS).set('Authorization', `Bearer ${user.session.accessToken}`);
    for (let i = 0; i <= MAX_FILES_PER_UPLOAD; i += 1) {
      pending = pending.attach('files', FIXTURES.text(`File ${String(i)}\n`), {
        filename: uniqueFilename(),
      });
    }

    const response = await pending;
    expect(response.status).toBe(422);
  });

  it('rejects a request with no file at all', async () => {
    const user = await createVerifiedUser();

    const response = await request()
      .post(DOCUMENTS)
      .set('Authorization', `Bearer ${user.session.accessToken}`);

    expectApiError(response, 422, ERROR_CODES.VALIDATION_ERROR);
  });

  describe('access control', () => {
    it('requires authentication', async () => {
      const response = await request().post(DOCUMENTS);
      expectApiError(response, 401, ERROR_CODES.UNAUTHORIZED);
    });

    it('requires a verified email address (FR-5)', async () => {
      // The first real consumer of `requireVerified`: an unverified account
      // keeps the shell and Settings but cannot upload.
      const user = await createTestUser();

      const response = await upload(user.session.accessToken, 'notes.txt', FIXTURES.text());
      expectApiError(response, 403, ERROR_CODES.EMAIL_NOT_VERIFIED);
      expect(await countRows('documents')).toBe(0);
    });
  });
});

describe('GET /documents', () => {
  it('lists only the caller’s documents, newest first', async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();

    await uploadDocument(owner.session.accessToken, { filename: 'first.txt' });
    await uploadDocument(owner.session.accessToken, { filename: 'second.txt' });
    await uploadDocument(stranger.session.accessToken, { filename: 'theirs.txt' });

    const response = await authenticatedRequest(owner.session.accessToken)
      .get('/documents')
      .expect(200);

    expect(response.body.items).toHaveLength(2);
    expect(response.body.items[0].filename).toBe('second.txt');
    expect(response.body.items.map((d: { filename: string }) => d.filename)).not.toContain('theirs.txt');
  });

  it('never exposes internal columns', async () => {
    const user = await createVerifiedUser();
    await uploadDocument(user.session.accessToken);

    const response = await authenticatedRequest(user.session.accessToken).get('/documents').expect(200);

    /*
      `contentHash` in particular: exposing it would let one user probe
      whether another holds a given file by uploading it and watching for a
      dedup response.
    */
    for (const field of ['storageKey', 'contentHash', 'userId', 'originalName']) {
      expect(response.body.items[0]).not.toHaveProperty(field);
    }
  });

  it('paginates with a cursor rather than an offset', async () => {
    // Offset shifts and duplicates rows when items are inserted at the head,
    // which is exactly what a document list does mid-upload.
    const user = await createVerifiedUser();
    for (let i = 0; i < 3; i += 1) {
      await uploadDocument(user.session.accessToken, { filename: `doc-${String(i)}.txt` });
    }

    const first = await authenticatedRequest(user.session.accessToken)
      .get('/documents?limit=2')
      .expect(200);

    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await authenticatedRequest(user.session.accessToken)
      .get(`/documents?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);

    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();

    const seen = [...first.body.items, ...second.body.items].map((d: { id: string }) => d.id);
    expect(new Set(seen).size).toBe(3);
  });

  it('returns the first page for a malformed cursor rather than an error', async () => {
    // A cursor is opaque, so a client cannot repair one; a 422 on a stale
    // bookmark is a worse outcome than starting over.
    const user = await createVerifiedUser();
    await uploadDocument(user.session.accessToken);

    const response = await authenticatedRequest(user.session.accessToken)
      .get('/documents?cursor=not-a-real-cursor')
      .expect(200);

    expect(response.body.items).toHaveLength(1);
  });

  it('filters by status', async () => {
    const user = await createVerifiedUser();
    const ready = await uploadDocument(user.session.accessToken, { filename: 'ready.txt' });
    await uploadDocument(user.session.accessToken, { filename: 'queued.txt' });
    await setDocumentStatus(ready.id, 'ready');

    const response = await authenticatedRequest(user.session.accessToken)
      .get('/documents?status=ready')
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(ready.id);
  });

  it('rejects an unknown status value', async () => {
    const user = await createVerifiedUser();

    const response = await authenticatedRequest(user.session.accessToken).get('/documents?status=bogus');
    expectApiError(response, 422, ERROR_CODES.VALIDATION_ERROR);
  });

  it('surfaces the failure reason FR-13 requires', async () => {
    const user = await createVerifiedUser();
    const document = await uploadDocument(user.session.accessToken);
    await setDocumentStatus(document.id, 'failed', {
      code: 'NO_TEXT_LAYER',
      message: 'This PDF has no extractable text — it looks like a scanned image.',
    });

    const response = await authenticatedRequest(user.session.accessToken).get('/documents').expect(200);

    expect(response.body.items[0].status).toBe('failed');
    expect(response.body.items[0].errorCode).toBe('NO_TEXT_LAYER');
    expect(response.body.items[0].errorMessage).toContain('scanned image');
  });

  it('returns an empty page for a user with no documents', async () => {
    const user = await createVerifiedUser();

    const response = await authenticatedRequest(user.session.accessToken).get('/documents').expect(200);

    expect(response.body).toEqual({ items: [], nextCursor: null });
  });
});

describe('GET /documents/:id', () => {
  it('returns the caller’s own document', async () => {
    const user = await createVerifiedUser();
    const document = await uploadDocument(user.session.accessToken);

    const response = await authenticatedRequest(user.session.accessToken)
      .get(`/documents/${document.id}`)
      .expect(200);

    expect(response.body.id).toBe(document.id);
  });

  it('answers 404 — not 403 — for another user’s document', async () => {
    /*
      A 403 would confirm the id is real, which is exactly what an IDOR probe
      is looking for. The repository scopes by owner, so the miss arrives
      naturally rather than depending on a check somebody remembered to write.
    */
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const document = await uploadDocument(owner.session.accessToken);

    const response = await authenticatedRequest(stranger.session.accessToken).get(
      `/documents/${document.id}`,
    );

    expectApiError(response, 404, ERROR_CODES.NOT_FOUND);
  });

  it('answers 404 for an id that does not exist', async () => {
    const user = await createVerifiedUser();

    const response = await authenticatedRequest(user.session.accessToken).get(
      '/documents/019fe000-0000-7000-8000-000000000000',
    );

    expectApiError(response, 404, ERROR_CODES.NOT_FOUND);
  });

  it('rejects a malformed id with 422', async () => {
    const user = await createVerifiedUser();

    const response = await authenticatedRequest(user.session.accessToken).get('/documents/not-a-uuid');
    expectApiError(response, 422, ERROR_CODES.VALIDATION_ERROR);
  });
});

describe('DELETE /documents/:id', () => {
  it('removes the row and the bytes, completely (FR-15)', async () => {
    const user = await createVerifiedUser();
    const document = await uploadDocument(user.session.accessToken);
    const row = await readDocumentRow(document.id);

    expect(await storageProvider.exists(row.storageKey)).toBe(true);

    const response = await authenticatedRequest(user.session.accessToken).delete(
      `/documents/${document.id}`,
    );

    expectNoContent(response);
    // No soft delete — docs/04-data-and-api.md §1.2 forbids retaining content.
    expect(await countRows('documents')).toBe(0);
    expect(await storageProvider.exists(row.storageKey)).toBe(false);
  });

  it('refuses to delete another user’s document, and leaves it intact', async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const document = await uploadDocument(owner.session.accessToken);

    const response = await authenticatedRequest(stranger.session.accessToken).delete(
      `/documents/${document.id}`,
    );

    expectApiError(response, 404, ERROR_CODES.NOT_FOUND);
    expect(await countRows('documents')).toBe(1);

    const row = await readDocumentRow(document.id);
    expect(await storageProvider.exists(row.storageKey)).toBe(true);
  });

  it('answers 404 on a second delete', async () => {
    const user = await createVerifiedUser();
    const document = await uploadDocument(user.session.accessToken);

    await authenticatedRequest(user.session.accessToken).delete(`/documents/${document.id}`).expect(204);

    const repeat = await authenticatedRequest(user.session.accessToken).delete(
      `/documents/${document.id}`,
    );
    expectApiError(repeat, 404, ERROR_CODES.NOT_FOUND);
  });

  it('frees the content hash, so the same file can be uploaded again', async () => {
    const user = await createVerifiedUser();
    const bytes = FIXTURES.text('Deleted then restored.\n');
    const first = await uploadDocument(user.session.accessToken, { bytes });

    await authenticatedRequest(user.session.accessToken).delete(`/documents/${first.id}`).expect(204);

    const second = await uploadDocument(user.session.accessToken, { bytes });
    expect(second.id).not.toBe(first.id);
  });
});

describe('GET /documents/usage', () => {
  it('reports bytes and counts against the documented caps (FR-16)', async () => {
    const user = await createVerifiedUser();
    const bytes = FIXTURES.text('Some content to measure.\n');
    await uploadDocument(user.session.accessToken, { bytes });

    const response = await authenticatedRequest(user.session.accessToken)
      .get('/documents/usage')
      .expect(200);

    expect(response.body.usedBytes).toBe(bytes.length);
    expect(response.body.documentCount).toBe(1);
    expect(response.body.limitBytes).toBeGreaterThan(0);
    expect(response.body.documentLimit).toBeGreaterThan(0);
  });

  it('counts only the caller’s own usage', async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    await uploadDocument(stranger.session.accessToken, { bytes: FIXTURES.text('theirs\n') });

    const response = await authenticatedRequest(owner.session.accessToken)
      .get('/documents/usage')
      .expect(200);

    expect(response.body.usedBytes).toBe(0);
    expect(response.body.documentCount).toBe(0);
  });

  it('is reachable without being mistaken for a document id', async () => {
    // `/usage` is registered before `/:id`; the reverse order captures the
    // literal path as an id and answers 422 on a route that exists.
    const user = await createVerifiedUser();
    await authenticatedRequest(user.session.accessToken).get('/documents/usage').expect(200);
  });
});
