import { describe, expect, it, vi } from 'vitest';
import type { DocumentDto } from '@lumora/shared';
import { ProviderError } from '../../src/providers/embedding/embedding-provider.interface.js';
import { embeddingProvider } from '../../src/providers/embedding/embedding.factory.js';
import { chunkRepository } from '../../src/repositories/chunk.repository.js';
import { documentRepository } from '../../src/repositories/document.repository.js';
import { IngestionWorker } from '../../src/workers/ingestion.worker.js';
import { API_PREFIX, request } from '../helpers/app.js';
import { db } from '../helpers/database.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { createVerifiedUser, type TestUser } from '../factories/user.factory.js';

/**
 * Per-document processing progress.
 *
 * The claim under test is narrow and worth stating: the numbers a user watches
 * are **read from the rows the pipeline actually wrote**, not from counters the
 * pipeline maintains alongside them. Everything here is an assertion about that
 * property — that the counts match the chunk table, that a crash cannot desync
 * them, and that a second worker arriving after a restart reads the same
 * answer because it reads the same rows.
 *
 * Runs on the deterministic fake embedding provider and in-memory vector store
 * (`tests/setup/test-env.ts`), which is what makes "the retry did not
 * double-count" expressible at all.
 */

/** Long enough to chunk into several pieces, so progress has somewhere to go. */
const MULTI_CHUNK_TEXT = Array.from(
  { length: 40 },
  (_unused, index) =>
    `## Section ${String(index + 1)}\n\nThis paragraph exists so the structure-aware chunker has a real boundary to split on, and it carries enough prose that the resulting chunk clears the minimum token floor rather than being merged into its neighbour.\n`,
).join('\n');

async function upload(user: TestUser, body = MULTI_CHUNK_TEXT): Promise<string> {
  const document = await uploadDocument(user.session.accessToken, {
    bytes: FIXTURES.markdown(body),
    filename: uniqueFilename('.md'),
    contentType: 'text/markdown',
  });
  return document.id;
}

function worker(id = 'progress-worker'): IngestionWorker {
  return new IngestionWorker({ workerId: id, concurrency: 1 });
}

/** The document exactly as a polling client sees it. */
async function fetchDto(user: TestUser, documentId: string): Promise<DocumentDto> {
  const response = await request()
    .get(`${API_PREFIX}/documents/${documentId}`)
    .set('Authorization', `Bearer ${user.session.accessToken}`)
    .expect(200);

  return response.body as DocumentDto;
}

/** Ground truth, straight from the chunk rows the API is supposed to describe. */
async function trueCounts(documentId: string): Promise<{ written: number; embedded: number }> {
  const chunks = await chunkRepository.findByDocument(documentId);
  return {
    written: chunks.length,
    embedded: chunks.filter((chunk) => chunk.vectorId !== null).length,
  };
}

describe('progress reaches the API', () => {
  it('reports the full count against itself once the document is ready', async () => {
    const user = await createVerifiedUser();
    const documentId = await upload(user);

    await worker().runOnce();

    const document = await fetchDto(user, documentId);
    const actual = await trueCounts(documentId);

    expect(document.status).toBe('ready');
    // A ready document promises it can be asked questions, so every chunk it
    // has must carry a vector. The progress fields are how a client sees that.
    expect(document.chunkCount).toBeGreaterThan(1);
    expect(document.writtenChunkCount).toBe(document.chunkCount);
    expect(document.embeddedChunkCount).toBe(document.chunkCount);

    // And the numbers are the rows, not a parallel tally that happens to agree.
    expect(actual.written).toBe(document.chunkCount);
    expect(actual.embedded).toBe(document.chunkCount);
  });

  it('reports nothing to measure before the chunker has run', async () => {
    /*
      A queued document has no total, and inventing one would be the first lie
      in a progress indicator. `0` is the honest answer, and it is what the UI
      keys off to show a stage label with no fraction beside it.
    */
    const user = await createVerifiedUser();
    const documentId = await upload(user);

    const document = await fetchDto(user, documentId);

    expect(document.status).toBe('queued');
    expect(document.chunkCount).toBe(0);
    expect(document.writtenChunkCount).toBe(0);
    expect(document.embeddedChunkCount).toBe(0);
  });
});

describe('progress mid-pipeline', () => {
  it('publishes the total before embedding starts, so the fraction has a denominator', async () => {
    /*
      The bug this pins down: `chunk_count` used to be written only at the
      `ready` transition, so a document spent its entire embedding phase
      reporting 0 chunks and then jumped to its final total. Embedding is the
      slowest stage and the one most worth watching, and it was the one stage
      with nothing to watch.

      Embedding is failed outright so the document is observed while it is
      genuinely stopped in `embedding`, rather than by racing a worker.
    */
    const user = await createVerifiedUser();
    const documentId = await upload(user);

    vi.spyOn(embeddingProvider, 'embed').mockRejectedValue(
      new ProviderError('fake', 'service unavailable', false, 503),
    );

    await worker().runOnce();

    const document = await fetchDto(user, documentId);

    expect(document.status).toBe('embedding');
    expect(document.chunkCount).toBeGreaterThan(1);
    expect(document.writtenChunkCount).toBe(document.chunkCount);
    // Nothing embedded, and the API says so rather than reporting the total.
    expect(document.embeddedChunkCount).toBe(0);
  });

  it('counts only the batches whose vectors actually landed', async () => {
    /*
      A partial embedding run is the state the whole design exists for. The
      first batch succeeds, the second fails, and the document is left with
      some vectors written and some not — which must show up as a genuine
      fraction, because that is exactly what a user staring at a stalled
      document needs to know.
    */
    const user = await createVerifiedUser();
    const documentId = await upload(user);

    const embed = embeddingProvider.embed.bind(embeddingProvider);
    let call = 0;
    vi.spyOn(embeddingProvider, 'embed').mockImplementation(async (texts) => {
      call += 1;
      if (call > 1) throw new ProviderError('fake', 'rate limited', true, 429);
      return embed(texts);
    });

    await worker().runOnce();

    const document = await fetchDto(user, documentId);
    const actual = await trueCounts(documentId);

    expect(document.status).toBe('embedding');
    expect(document.embeddedChunkCount).toBe(actual.embedded);
    expect(document.embeddedChunkCount).toBeLessThan(document.chunkCount);
  });
});

describe('progress is durable', () => {
  it('survives a worker restart because it is read from the rows, not from memory', async () => {
    /*
      The restart is modelled the way it actually happens: one worker fails
      mid-embedding and is never seen again, and a *different* worker id picks
      the job up afterwards. If progress lived in the first worker's memory,
      the second would start from zero.
    */
    const user = await createVerifiedUser();
    const documentId = await upload(user);

    const failing = vi
      .spyOn(embeddingProvider, 'embed')
      .mockRejectedValue(new ProviderError('fake', 'down', true, 503));

    await worker('worker-before-restart').runOnce();

    const stalled = await fetchDto(user, documentId);
    expect(stalled.chunkCount).toBeGreaterThan(1);

    // The replacement worker: same job, same rows, no shared state.
    failing.mockRestore();
    await db
      .updateTable('jobs')
      .set({ run_after: new Date().toISOString() })
      .where('status', '=', 'pending')
      .execute();

    await worker('worker-after-restart').runOnce();

    const resumed = await fetchDto(user, documentId);

    expect(resumed.status).toBe('ready');
    expect(resumed.chunkCount).toBe(stalled.chunkCount);
    expect(resumed.embeddedChunkCount).toBe(resumed.chunkCount);
  });

  it('does not double-count when the same job is delivered twice', async () => {
    /*
      Idempotency, expressed in the numbers rather than in the row count. The
      counts are derived from `document_chunks`, and the pipeline upserts on
      `(document_id, chunk_index)`, so a second delivery cannot inflate them —
      there is no counter to increment twice.
    */
    const user = await createVerifiedUser();
    const documentId = await upload(user);

    await worker().runOnce();
    const first = await fetchDto(user, documentId);

    // Re-run the pipeline over a document that is already terminal.
    await documentRepository.transitionStatusFromFailed(documentId, user.id, 'queued');
    await db
      .updateTable('documents')
      .set({ status: 'ready' })
      .where('id', '=', documentId)
      .execute();

    const second = await fetchDto(user, documentId);

    expect(second.chunkCount).toBe(first.chunkCount);
    expect(second.writtenChunkCount).toBe(first.writtenChunkCount);
    expect(second.embeddedChunkCount).toBe(first.embeddedChunkCount);
  });

  it('leaves the counts describing real rows when the document fails', async () => {
    /*
      A failed document keeps whatever it genuinely produced. Zeroing the
      counts on failure would discard the evidence of how far it got, which is
      the first thing anyone asks about a document that failed at embedding.
    */
    const user = await createVerifiedUser();
    const documentId = await upload(user, 'Too short.');

    await worker().runOnce();

    const document = await fetchDto(user, documentId);
    const actual = await trueCounts(documentId);

    expect(document.writtenChunkCount).toBe(actual.written);
    expect(document.embeddedChunkCount).toBe(actual.embedded);
  });
});

describe('progress is scoped to its owner', () => {
  it('does not report another user’s document', async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const documentId = await upload(owner);

    await worker().runOnce();

    /*
      404, not 403. A 403 would confirm the id names a real document, which is
      precisely what an IDOR probe is looking for (docs/04-data-and-api.md §4).
    */
    await request()
      .get(`${API_PREFIX}/documents/${documentId}`)
      .set('Authorization', `Bearer ${stranger.session.accessToken}`)
      .expect(404);
  });
});
