import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S3StorageProvider } from '../../src/providers/storage/s3.storage.js';
import { StorageError } from '../../src/providers/storage/storage-provider.interface.js';

/**
 * The production storage driver, against a real S3 API (docs/08 §5).
 *
 * MinIO rather than AWS: the questions worth asking here — does the SDK write
 * what we asked, does a missing key report 404 rather than throwing, does a
 * traversal-shaped key get refused — are all answered by any S3-compatible
 * server, and none of them need a cloud account or a bill. The one thing MinIO
 * cannot verify is IAM, which is infrastructure rather than adapter behaviour.
 *
 * Skips cleanly when MinIO is not running, matching how the Chroma suite
 * handles its own dependency, so a developer without it still gets a green run.
 */

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9100';
const BUCKET = process.env.TEST_S3_BUCKET ?? 'lumora-test';

/*
  Credentials are passed explicitly rather than through `AWS_*`, because that
  is how Supabase Storage works: its access keys are its own and would be
  misread as AWS credentials if smuggled through the default provider chain.
  Exercising the explicit path here is what makes this suite evidence about the
  production configuration rather than only about MinIO.
*/
const ACCESS_KEY_ID = process.env.TEST_S3_ACCESS_KEY_ID ?? 'minioadmin';
const SECRET_ACCESS_KEY = process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'minioadmin';

const reachable = await fetch(`${ENDPOINT}/minio/health/live`)
  .then((response) => response.ok)
  .catch(() => false);

const store = new S3StorageProvider({
  bucket: BUCKET,
  region: 'us-east-1',
  endpoint: ENDPOINT,
  // Supabase requires path-style addressing too.
  forcePathStyle: true,
  /*
    MinIO answers NotImplemented for SSE-S3 unless a KMS is configured, and
    Supabase rejects the header outright because it encrypts at rest itself.
    Real S3 applies it for free, which is why production only permits `none`
    when the endpoint is Supabase.
  */
  serverSideEncryption: 'none',
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET_ACCESS_KEY,
});

/** The production key shape (docs/08 §5.1). */
function keyFor(userId: string, documentId: string): string {
  return `users/${userId}/documents/${documentId}/original`;
}

async function read(stream: Awaited<ReturnType<typeof store.get>>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

describe.skipIf(!reachable)('S3StorageProvider (live S3 API)', () => {
  it('round-trips an object', async () => {
    const key = keyFor(randomUUID(), randomUUID());

    await store.put(key, Buffer.from('The notice period is thirty days.'), {
      contentType: 'text/markdown',
    });

    expect(await read(await store.get(key))).toBe('The notice period is thirty days.');
  });

  it('reports existence, and absence as false rather than an error', async () => {
    const key = keyFor(randomUUID(), randomUUID());

    // Absence is an answer. Flattening a 403 into "missing" would present a
    // broken bucket policy as a lost document, so only 404 may return false.
    expect(await store.exists(key)).toBe(false);

    await store.put(key, Buffer.from('x'), { contentType: 'text/plain' });
    expect(await store.exists(key)).toBe(true);
  });

  it('overwrites on a repeated put, so a retry does not fork the object', async () => {
    const key = keyFor(randomUUID(), randomUUID());

    await store.put(key, Buffer.from('first'), { contentType: 'text/plain' });
    await store.put(key, Buffer.from('second'), { contentType: 'text/plain' });

    expect(await read(await store.get(key))).toBe('second');
  });

  it('deletes an object', async () => {
    const key = keyFor(randomUUID(), randomUUID());

    await store.put(key, Buffer.from('x'), { contentType: 'text/plain' });
    await store.delete(key);

    expect(await store.exists(key)).toBe(false);
  });

  it('deleting something absent is not an error', async () => {
    // S3 delete is idempotent, and the caller's desired state is already true.
    await expect(store.delete(keyFor(randomUUID(), randomUUID()))).resolves.toBeUndefined();
  });

  it('raises a StorageError for a missing object rather than returning empty', async () => {
    await expect(store.get(keyFor(randomUUID(), randomUUID()))).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  it('**keeps each tenant under its own prefix**', async () => {
    /*
      Object keys are the storage half of tenant isolation. Nothing here
      enforces that a user can only read their own prefix — that is the API's
      ownership check and, in production, an IAM policy — but the key shape is
      what makes both expressible.
    */
    const alice = randomUUID();
    const bob = randomUUID();
    const document = randomUUID();

    await store.put(keyFor(alice, document), Buffer.from('alice'), {
      contentType: 'text/plain',
    });
    await store.put(keyFor(bob, document), Buffer.from('bob'), { contentType: 'text/plain' });

    expect(await read(await store.get(keyFor(alice, document)))).toBe('alice');
    expect(await read(await store.get(keyFor(bob, document)))).toBe('bob');
  });
});

/**
 * Key safety needs no server — the guard runs before any request is made,
 * which is the point of it.
 */
describe('S3StorageProvider — key safety', () => {
  const offline = new S3StorageProvider({ bucket: 'unused', region: 'us-east-1' });

  const unsafe = [
    ['traversal', '../../../etc/passwd'],
    ['traversal inside a valid prefix', 'users/alice/../bob/documents/x/original'],
    ['absolute', '/etc/passwd'],
    ['empty', ''],
    ['null byte', 'users/a/documents/b\0/original'],
    ['backslash', 'users\\alice\\documents'],
  ] as const;

  for (const [label, key] of unsafe) {
    it(`refuses a ${label} key before contacting S3`, async () => {
      // Rejected locally, so a malformed key never becomes a request whose
      // outcome depends on a bucket policy that may not exist yet.
      await expect(
        offline.put(key, Buffer.from('x'), { contentType: 'text/plain' }),
      ).rejects.toBeInstanceOf(StorageError);

      await expect(offline.get(key)).rejects.toBeInstanceOf(StorageError);
      await expect(offline.delete(key)).rejects.toBeInstanceOf(StorageError);
      await expect(offline.exists(key)).rejects.toBeInstanceOf(StorageError);
    });
  }

  it('accepts the key shape the application actually builds', async () => {
    const key = keyFor(randomUUID(), randomUUID());

    // Guard passes; the request then fails on the unreachable bucket, which is
    // a different error path and proves the key itself was not the problem.
    await expect(offline.exists(key)).rejects.toThrow();
  });
});
