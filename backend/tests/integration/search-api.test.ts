import { describe, expect, it } from 'vitest';
import { ERROR_CODES, MAX_QUERY_LENGTH, MAX_RESULTS, type EvidenceBundleDto } from '@lumora/shared';
import { IngestionWorker } from '../../src/workers/ingestion.worker.js';
import { API_PREFIX, request } from '../helpers/app.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { createTestUser, createVerifiedUser, type TestUser } from '../factories/user.factory.js';

/**
 * `GET`/`POST /search` — the retrieval-only endpoint from
 * docs/06-roadmap.md M4.
 *
 * These paths are **not** in docs/04-data-and-api.md §2's API table; the docs
 * specify the artefact ("a development-only endpoint that returns retrieval
 * results without generation") and not its shape. The contract asserted here
 * is therefore new, and mounting is gated on `SEARCH_API_ENABLED`.
 */

const BODY = [
  '# Employment Agreement',
  '',
  '## 3. Termination',
  '',
  'Either party may terminate this agreement with thirty days written notice delivered to the address of record, and the notice period begins the following day.',
  '',
  '## 4. Equipment',
  '',
  'Each employee is issued one ACME-1200/B workstation and a set of replacement rails under part number RL-88.',
].join('\n');

async function seed(user: TestUser, body = BODY): Promise<string> {
  const document = await uploadDocument(user.session.accessToken, {
    bytes: FIXTURES.markdown(body),
    filename: uniqueFilename('.md'),
    contentType: 'text/markdown',
  });

  await new IngestionWorker({ workerId: 'search-seed', concurrency: 1 }).drain();
  return document.id;
}

/** An authenticated `GET /search` with a raw query string. */
function get(user: TestUser, query: string) {
  return request()
    .get(`${API_PREFIX}/search?${query}`)
    .set('Authorization', `Bearer ${user.session.accessToken}`);
}

describe('GET /search', () => {
  it('answers 200 with an evidence bundle', async () => {
    const user = await createVerifiedUser();
    await seed(user);

    const response = await get(user, 'q=notice+period').expect(200);
    const bundle = response.body as EvidenceBundleDto;

    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(bundle.query).toBe('notice period');
    expect(bundle.abstain).toBe(false);
  });

  it('returns every field a citation needs', async () => {
    const user = await createVerifiedUser();
    await seed(user);

    const response = await get(user, 'q=notice+period').expect(200);
    const [chunk] = (response.body as EvidenceBundleDto).chunks;

    expect(chunk).toMatchObject({
      chunkId: expect.any(String),
      documentId: expect.any(String),
      documentTitle: expect.any(String),
      text: expect.any(String),
      chunkIndex: expect.any(Number),
      tokenCount: expect.any(Number),
      score: expect.any(Number),
    });
    expect(['vector', 'bm25', 'hybrid']).toContain(chunk?.source);
  });

  it('reports stats and timings for debugging', async () => {
    // The endpoint exists to make "the answer is wrong" attributable; a bundle
    // with no provenance would not do that.
    const user = await createVerifiedUser();
    await seed(user);

    const bundle = (await get(user, 'q=notice').expect(200)).body as EvidenceBundleDto;

    expect(bundle.stats.vectorCandidates).toBeGreaterThanOrEqual(0);
    expect(bundle.stats.lexicalCandidates).toBeGreaterThanOrEqual(0);
    expect(bundle.stats.returned).toBe(bundle.chunks.length);
    expect(bundle.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('answers 200 when it abstains, not 404', async () => {
    /*
      An abstention is a successful retrieval that found nothing worth
      answering from. A 404 would make the client treat a correct answer as an
      error.
    */
    const user = await createVerifiedUser();

    const response = await get(user, 'q=anything+at+all').expect(200);
    const bundle = response.body as EvidenceBundleDto;

    expect(bundle.abstain).toBe(true);
    expect(bundle.abstainReason).toBe('empty-corpus');
    expect(bundle.chunks).toEqual([]);
  });

  it('honours k', async () => {
    const user = await createVerifiedUser();
    await seed(user);

    const bundle = (await get(user, 'q=notice+OR+workstation&k=1').expect(200))
      .body as EvidenceBundleDto;

    expect(bundle.chunks.length).toBeLessThanOrEqual(1);
  });

  it('filters by document', async () => {
    const user = await createVerifiedUser();
    const kept = await seed(user);
    await seed(user, '# Other\n\nA completely separate document about gardening and soil.');

    const bundle = (await get(user, `q=notice+OR+soil&documentId=${kept}`).expect(200))
      .body as EvidenceBundleDto;

    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(bundle.chunks.every((chunk) => chunk.documentId === kept)).toBe(true);
  });

  it('accepts a repeated documentId', async () => {
    const user = await createVerifiedUser();
    const first = await seed(user);
    const second = await seed(user, '# Second\n\nAnother document mentioning the notice period.');

    const bundle = (await get(user, `q=notice&documentId=${first}&documentId=${second}`).expect(200))
      .body as EvidenceBundleDto;

    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(
      bundle.chunks.every((chunk) => chunk.documentId === first || chunk.documentId === second),
    ).toBe(true);
  });

  it('finds an exact identifier the semantic half would miss', async () => {
    // §3.2's stated reason for the lexical half, asserted end to end.
    const user = await createVerifiedUser();
    await seed(user);

    const bundle = (await get(user, 'q=RL-88').expect(200)).body as EvidenceBundleDto;

    expect(bundle.chunks.some((chunk) => chunk.text.includes('RL-88'))).toBe(true);
  });

  it('rejects a missing query', async () => {
    const user = await createVerifiedUser();

    const response = await request()
      .get(`${API_PREFIX}/search`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(422);

    expect((response.body as { error: { code: string } }).error.code).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('rejects a query that is only whitespace', async () => {
    const user = await createVerifiedUser();

    await get(user, 'q=+++').expect(422);
  });

  it('rejects a query beyond the length cap', async () => {
    // Told, not truncated: a user who pasted too much should not have their
    // question quietly cut in half.
    const user = await createVerifiedUser();

    await get(user, `q=${'a'.repeat(MAX_QUERY_LENGTH + 1)}`).expect(422);
  });

  it('rejects a k above the documented final K', async () => {
    // §3.3 fixes final K ≤ 6; a bundle of 50 could not fit the §4.1 budget.
    const user = await createVerifiedUser();

    await get(user, `q=notice&k=${String(MAX_RESULTS + 1)}`).expect(422);
  });

  it('rejects a malformed documentId', async () => {
    const user = await createVerifiedUser();

    await get(user, 'q=notice&documentId=not-a-uuid').expect(422);
  });

  it('requires authentication', async () => {
    await request().get(`${API_PREFIX}/search?q=notice`).expect(401);
  });

  it('serves an account that has not confirmed its email', async () => {
    /*
      This asserted a 403 until the verification gate was removed. Retrieval is
      scoped by `user_id` on the lexical half and by a per-user collection on
      the vector half, so an unconfirmed address changes nothing about what
      this endpoint can reach — see `never returns another user’s chunks`,
      which is the assertion that actually protects the corpus.
    */
    const user = await createTestUser();

    await request()
      .get(`${API_PREFIX}/search?q=notice`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(200);
  });

  it('never returns another user’s chunks', async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    await seed(owner);

    const bundle = (await get(stranger, 'q=notice+period').expect(200)).body as EvidenceBundleDto;

    expect(bundle.chunks).toEqual([]);
  });

  it('cannot be made to search another user’s document by id', async () => {
    // The filter narrows within the caller's corpus; it is not a way into
    // someone else's. Tenancy is the collection and the `user_id` predicate.
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const documentId = await seed(owner);

    const bundle = (await get(stranger, `q=notice&documentId=${documentId}`).expect(200))
      .body as EvidenceBundleDto;

    expect(bundle.chunks).toEqual([]);
  });
});

describe('POST /search', () => {
  it('accepts the structured form', async () => {
    const user = await createVerifiedUser();
    await seed(user);

    const response = await request()
      .post(`${API_PREFIX}/search`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .send({ query: 'notice period' })
      .expect(200);

    expect((response.body as EvidenceBundleDto).chunks.length).toBeGreaterThan(0);
  });

  it('filters by a list of documents', async () => {
    // The reason POST exists alongside GET: a repeated query parameter is a
    // worse contract than a JSON array once there is more than one.
    const user = await createVerifiedUser();
    const kept = await seed(user);
    await seed(user, '# Other\n\nA separate document about unrelated matters entirely.');

    const response = await request()
      .post(`${API_PREFIX}/search`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .send({ query: 'notice OR unrelated', filters: { documentIds: [kept] } })
      .expect(200);

    const bundle = response.body as EvidenceBundleDto;
    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(bundle.chunks.every((chunk) => chunk.documentId === kept)).toBe(true);
  });

  it('honours topK', async () => {
    const user = await createVerifiedUser();
    await seed(user);

    const response = await request()
      .post(`${API_PREFIX}/search`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .send({ query: 'notice period', topK: 1 })
      .expect(200);

    expect((response.body as EvidenceBundleDto).chunks.length).toBeLessThanOrEqual(1);
  });

  it('rejects an empty query', async () => {
    const user = await createVerifiedUser();

    await request()
      .post(`${API_PREFIX}/search`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .send({ query: '' })
      .expect(422);
  });

  it('rejects an unknown filter shape', async () => {
    const user = await createVerifiedUser();

    await request()
      .post(`${API_PREFIX}/search`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .send({ query: 'notice', filters: { documentIds: 'not-an-array' } })
      .expect(422);
  });

  it('returns the same bundle as the GET form', async () => {
    // Two doors, one engine — a divergence would make the debugging tool lie
    // about what the chat path will see.
    const user = await createVerifiedUser();
    await seed(user);

    const viaGet = (await get(user, 'q=notice+period').expect(200)).body as EvidenceBundleDto;
    const viaPost = (
      await request()
        .post(`${API_PREFIX}/search`)
        .set('Authorization', `Bearer ${user.session.accessToken}`)
        .send({ query: 'notice period' })
        .expect(200)
    ).body as EvidenceBundleDto;

    expect(viaPost.chunks.map((chunk) => chunk.chunkId)).toEqual(
      viaGet.chunks.map((chunk) => chunk.chunkId),
    );
  });
});
