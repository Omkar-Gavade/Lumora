import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DocumentStatus } from '@lumora/shared';
import type { DB } from '../../src/db/schema.js';
import { documentRepository } from '../../src/repositories/document.repository.js';
import { withTransaction } from '../helpers/database.js';

/**
 * The guarded status transitions the pipeline is built on.
 *
 * Tested here rather than only through the pipeline because the property that
 * matters — that a transition is a compare-and-set, not a read followed by a
 * write — is about what happens when two callers try at once, and an
 * end-to-end test can only *hope* to interleave them at the right instant. A
 * direct second call is the same race with the timing removed.
 *
 * Wrapped in rolled-back transactions (docs/03-backend.md §9): the executor is
 * injectable here, so nothing needs truncating.
 */

async function seedDocument(
  trx: Transaction<DB>,
  status: DocumentStatus = 'queued',
): Promise<{ documentId: string; userId: string }> {
  const user = await trx
    .insertInto('users')
    .values({
      email: `transitions-${randomUUID()}@example.test`,
      // Never authenticated against — this suite exercises SQL, not login.
      password_hash: 'not-a-real-hash',
      display_name: 'Transitions Fixture',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const document = await documentRepository.create(
    {
      userId: user.id,
      filename: `${randomUUID()}.txt`,
      originalName: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 128,
      contentHash: randomUUID(),
      storageKey: `documents/${user.id}/${randomUUID()}`,
    },
    trx,
  );

  if (status !== 'queued') {
    await trx
      .updateTable('documents')
      .set({ status })
      .where('id', '=', document.id)
      .execute();
  }

  return { documentId: document.id, userId: user.id };
}

describe('transitionStatus', () => {
  it('advances a document that is in a legal preceding state', async () => {
    await withTransaction(async (trx) => {
      const { documentId, userId } = await seedDocument(trx);

      const updated = await documentRepository.transitionStatus(
        documentId,
        userId,
        { from: ['queued'], to: 'parsing' },
        trx,
      );

      expect(updated?.status).toBe('parsing');
    });
  });

  it('refuses a transition from a state that is not permitted', async () => {
    await withTransaction(async (trx) => {
      const { documentId, userId } = await seedDocument(trx, 'ready');

      const updated = await documentRepository.transitionStatus(
        documentId,
        userId,
        { from: ['queued', 'parsing'], to: 'parsing' },
        trx,
      );

      expect(updated).toBeNull();
    });
  });

  it('lets only the first of two identical transitions through', async () => {
    /*
      The compare-and-set property, and the reason the guard lives in the
      `WHERE` clause rather than in a preceding read.

      Two workers can hold the same document — the reaper reclaims a lease a
      moment before the original worker finishes, and for a few seconds both
      believe they own it. A read-then-write lets both pass the check; this
      lets exactly one row match, and the loser learns it lost from the return
      value.
    */
    await withTransaction(async (trx) => {
      const { documentId, userId } = await seedDocument(trx);
      const transition = { from: ['queued'] as DocumentStatus[], to: 'parsing' as const };

      const first = await documentRepository.transitionStatus(documentId, userId, transition, trx);
      const second = await documentRepository.transitionStatus(documentId, userId, transition, trx);

      expect(first?.status).toBe('parsing');
      expect(second).toBeNull();
    });
  });

  it('records page and token counts alongside the status', async () => {
    await withTransaction(async (trx) => {
      const { documentId, userId } = await seedDocument(trx, 'parsing');

      const updated = await documentRepository.transitionStatus(
        documentId,
        userId,
        { from: ['parsing'], to: 'chunking', pageCount: 12, tokenCount: 3_400 },
        trx,
      );

      expect(updated).toMatchObject({ status: 'chunking', pageCount: 12, tokenCount: 3_400 });
    });
  });

  it('clears a stale failure reason when the document progresses', async () => {
    // A previous attempt's error left on a row that is now advancing would
    // show the user a failure reason beside a live progress bar.
    await withTransaction(async (trx) => {
      const { documentId, userId } = await seedDocument(trx, 'parsing');
      await trx
        .updateTable('documents')
        .set({ error_code: 'CORRUPT_FILE', error_message: 'previous attempt' })
        .where('id', '=', documentId)
        .execute();

      const updated = await documentRepository.transitionStatus(
        documentId,
        userId,
        { from: ['parsing'], to: 'chunking' },
        trx,
      );

      expect(updated).toMatchObject({ errorCode: null, errorMessage: null });
    });
  });

  it('will not transition another user’s document', async () => {
    // Tenancy is enforced in the same statement, not by a preceding check.
    await withTransaction(async (trx) => {
      const { documentId } = await seedDocument(trx);

      const updated = await documentRepository.transitionStatus(
        documentId,
        randomUUID(),
        { from: ['queued'], to: 'parsing' },
        trx,
      );

      expect(updated).toBeNull();
    });
  });
});

describe('markFailed', () => {
  it('records the code and message FR-13 shows the user', async () => {
    await withTransaction(async (trx) => {
      const { documentId, userId } = await seedDocument(trx, 'parsing');

      const failed = await documentRepository.markFailed(
        documentId,
        userId,
        'NO_TEXT_LAYER',
        'This PDF has no extractable text — it looks like a scanned image. OCR is not supported yet.',
        trx,
      );

      expect(failed).toMatchObject({
        status: 'failed',
        errorCode: 'NO_TEXT_LAYER',
      });
    });
  });

  it('fails from any working state, not just the previous one', async () => {
    // Refusing to record a failure because the row moved underneath us would
    // leave a document stuck mid-pipeline with nothing to explain it.
    for (const status of ['queued', 'parsing', 'chunking', 'embedding'] as DocumentStatus[]) {
      await withTransaction(async (trx) => {
        const { documentId, userId } = await seedDocument(trx, status);

        const failed = await documentRepository.markFailed(
          documentId,
          userId,
          'CORRUPT_FILE',
          'damaged',
          trx,
        );

        expect(failed?.status).toBe('failed');
      });
    }
  });

  it('will not drag a ready document back to failed', async () => {
    // A duplicate worker finishing late must not undo a document the user can
    // already query.
    await withTransaction(async (trx) => {
      const { documentId, userId } = await seedDocument(trx, 'ready');

      const failed = await documentRepository.markFailed(
        documentId,
        userId,
        'CORRUPT_FILE',
        'late arrival',
        trx,
      );

      expect(failed).toBeNull();

      const row = await trx
        .selectFrom('documents')
        .select(['status', 'error_code'])
        .where('id', '=', documentId)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: 'ready', error_code: null });
    });
  });

  it('does not overwrite the first failure with a second', async () => {
    // The first one is what the user was shown.
    await withTransaction(async (trx) => {
      const { documentId, userId } = await seedDocument(trx, 'parsing');

      await documentRepository.markFailed(documentId, userId, 'NO_TEXT_LAYER', 'scan', trx);
      const second = await documentRepository.markFailed(
        documentId,
        userId,
        'CORRUPT_FILE',
        'damaged',
        trx,
      );

      expect(second).toBeNull();

      const row = await trx
        .selectFrom('documents')
        .select('error_code')
        .where('id', '=', documentId)
        .executeTakeFirstOrThrow();
      expect(row.error_code).toBe('NO_TEXT_LAYER');
    });
  });

  it('truncates an oversized message rather than storing an essay on the row', async () => {
    await withTransaction(async (trx) => {
      const { documentId, userId } = await seedDocument(trx, 'parsing');

      const failed = await documentRepository.markFailed(
        documentId,
        userId,
        'CORRUPT_FILE',
        'x'.repeat(5_000),
        trx,
      );

      expect(failed?.errorMessage).toHaveLength(500);
    });
  });

  it('will not fail another user’s document', async () => {
    await withTransaction(async (trx) => {
      const { documentId } = await seedDocument(trx, 'parsing');

      expect(
        await documentRepository.markFailed(documentId, randomUUID(), 'CORRUPT_FILE', 'x', trx),
      ).toBeNull();
    });
  });
});
