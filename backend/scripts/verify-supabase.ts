/**
 * One command that proves a Supabase deployment actually works.
 *
 * Runs the checks docs/11 describes, in the order that makes a failure
 * diagnosable: configuration, then connectivity, then the extension, then the
 * schema, then object storage, then a real round trip through both. Each step
 * either passes or stops with the specific reason — a summary that says
 * "storage failed" without saying whether it was the key, the bucket, or the
 * endpoint costs more time than it saves.
 *
 *   npm run verify:supabase
 *
 * **Prints no secret.** Hostnames, bucket names and counts only. The values it
 * reads are exactly the ones the deployment will use, so a pass here means the
 * configuration is correct rather than merely present.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { PACKAGE_ROOT } from '../src/lib/paths.js';
import { S3StorageProvider } from '../src/providers/storage/s3.storage.js';

/*
  Loaded the same way and from the same file the application uses, so this
  verifies the configuration a deployment will actually run with rather than
  whatever happens to be exported in the shell. Real environment variables
  still win, which is what lets CI or a one-off run override a single value.
*/
dotenv.config({ path: join(PACKAGE_ROOT, '.env'), quiet: true });

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ''): boolean {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/** Host only. The rest of a connection string is a credential. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '<unparseable>';
  }
}

function required(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

async function main(): Promise<void> {
  console.log('\nSupabase verification (docs/11)\n');

  // ── 1. Configuration ──────────────────────────────────────────────────────
  console.log('1. Configuration');

  const names = [
    'DATABASE_URL',
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ] as const;

  const missing = names.filter((name) => required(name) === undefined);

  if (missing.length > 0) {
    record('required variables present', false, `missing: ${missing.join(', ')}`);
    console.log(
      '\nAdd these to backend/.env — see docs/11-supabase-deployment.md §4.\n' +
        'Use the POOLER connection string, not the direct one: direct is IPv6-only\n' +
        'on the free plan and most hosts cannot reach it.\n',
    );
    process.exit(1);
  }

  const databaseUrl = required('DATABASE_URL') ?? '';
  const endpoint = required('S3_ENDPOINT') ?? '';
  const bucket = required('S3_BUCKET') ?? '';

  record('required variables present', true, `${names.length} of ${names.length}`);

  const dbHost = hostOf(databaseUrl);
  record(
    'DATABASE_URL points at Supabase',
    dbHost.includes('supabase'),
    dbHost || '(none)',
  );
  record(
    'connection uses the pooler',
    dbHost.includes('pooler'),
    dbHost.includes('pooler') ? 'pooler' : 'DIRECT — IPv6 only, Koyeb cannot reach it',
  );
  record('TLS requested', /sslmode=(require|verify-ca|verify-full)/.test(databaseUrl), 'sslmode set');
  record(
    'TLS bypass not set',
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
      ? 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables verification process-wide'
      : 'certificate verification active',
  );
  record('S3_ENDPOINT is Supabase Storage', hostOf(endpoint).includes('supabase'), hostOf(endpoint));

  // ── 2. PostgreSQL ─────────────────────────────────────────────────────────
  console.log('\n2. PostgreSQL');

  /*
    Built from the application's own pool configuration rather than from the
    URL directly, so this verifies the TLS the deployment will actually use —
    pinned CA, verification on. Constructing a client here from
    `DATABASE_URL` would test a different connection than the one that ships.
  */
  const { databaseConfig } = await import('../src/config/database.js');
  const client = new Client({
    connectionString: databaseConfig.connectionString,
    ...(databaseConfig.ssl === undefined ? {} : { ssl: databaseConfig.ssl }),
  });

  try {
    await client.connect();
  } catch (error) {
    record('connect', false, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const version = await client.query<{ version: string }>('SELECT version()');
  record('connect', true, version.rows[0]?.version.split(',')[0] ?? '');

  // ── 3. pgvector ───────────────────────────────────────────────────────────
  console.log('\n3. pgvector');

  const extension = await client.query<{ installed_version: string | null }>(
    "SELECT installed_version FROM pg_available_extensions WHERE name = 'vector'",
  );

  const installed = extension.rows[0]?.installed_version ?? null;
  if (
    !record(
      'vector extension enabled',
      installed !== null,
      installed ?? 'not enabled — Database → Extensions → enable "vector"',
    )
  ) {
    await client.end();
    process.exit(1);
  }

  // ── 4. Schema ─────────────────────────────────────────────────────────────
  console.log('\n4. Schema');

  const applied = await client
    .query<{ count: string }>('SELECT count(*) AS count FROM schema_migrations')
    .catch(() => null);

  if (applied === null) {
    record('migrations applied', false, 'no schema_migrations table — run: npm run migrate');
  } else {
    const count = Number(applied.rows[0]?.count ?? 0);
    record('migrations applied', count === 8, `${String(count)} of 8`);
  }

  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  const present = new Set(tables.rows.map((row) => row.table_name));
  const expected = [
    'users',
    'refresh_tokens',
    'verification_tokens',
    'documents',
    'document_chunks',
    'conversations',
    'messages',
    'message_citations',
    'knowledge_bases',
    'knowledge_base_documents',
    'jobs',
    'usage_events',
    'document_vectors',
  ];
  const absent = expected.filter((name) => !present.has(name));
  record('all tables present', absent.length === 0, absent.length === 0 ? `${String(expected.length)} tables` : `missing: ${absent.join(', ')}`);

  // The HNSW index is what makes retrieval a search rather than a scan.
  const index = await client.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE tablename = 'document_vectors' AND indexname = 'document_vectors_embedding_idx'",
  );
  record('HNSW index on document_vectors', index.rows.length > 0, index.rows[0]?.indexdef.includes('hnsw') ? 'hnsw' : '');

  // ── 5. A real vector round trip ───────────────────────────────────────────
  console.log('\n5. Vector round trip');

  const probeCollection = `verify_${randomUUID().replace(/-/g, '')}`;
  const embedding = `[${new Array<number>(768).fill(0).map((_, i) => (i === 0 ? 1 : 0.001)).join(',')}]`;

  try {
    await client.query(
      `INSERT INTO document_vectors
         (collection, id, embedding, text, chunk_id, document_id, user_id, document_name, chunk_index)
       VALUES ($1, 'probe:0', $2::vector, 'probe', $3, $4, $5, 'probe.md', 0)`,
      [probeCollection, embedding, randomUUID(), randomUUID(), randomUUID()],
    );

    const search = await client.query<{ score: number }>(
      `SELECT 1 - (embedding <=> $2::vector) AS score
         FROM document_vectors WHERE collection = $1
         ORDER BY embedding <=> $2::vector LIMIT 1`,
      [probeCollection, embedding],
    );

    const score = Number(search.rows[0]?.score ?? 0);
    record('insert + similarity search', score > 0.99, `score=${score.toFixed(4)}`);
  } catch (error) {
    record('insert + similarity search', false, error instanceof Error ? error.message : String(error));
  } finally {
    await client.query('DELETE FROM document_vectors WHERE collection = $1', [probeCollection]);
  }

  await client.end();

  // ── 6. Storage ────────────────────────────────────────────────────────────
  console.log('\n6. Supabase Storage');

  const storage = new S3StorageProvider({
    bucket,
    region: required('S3_REGION') ?? 'us-east-1',
    endpoint,
    forcePathStyle: true,
    // Supabase encrypts at rest itself and rejects the SSE header.
    serverSideEncryption: 'none',
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  });

  const key = `users/${randomUUID()}/documents/${randomUUID()}/original`;
  const payload = 'lumora supabase storage verification';

  try {
    await storage.put(key, Buffer.from(payload), { contentType: 'text/plain' });
    record('put', true, `${String(Buffer.byteLength(payload))} bytes`);

    const stream = await storage.get(key);
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(Buffer.from(part as Buffer));
    record('get returns what was written', Buffer.concat(parts).toString('utf8') === payload);

    record('exists', await storage.exists(key));

    await storage.delete(key);
    record('delete', !(await storage.exists(key)));
  } catch (error) {
    record('storage round trip', false, error instanceof Error ? error.message : String(error));
  }

  // Traversal must be refused before a request is made, not by a bucket policy.
  try {
    await storage.exists('../../etc/passwd');
    record('rejects a traversal key', false, 'accepted a key it should refuse');
  } catch {
    record('rejects a traversal key', true);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const failed = checks.filter((check) => !check.ok);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);

  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const check of failed) console.log(`  - ${check.name}: ${check.detail}`);
    process.exit(1);
  }

  console.log('\nSupabase is correctly configured. Next: npm run verify:supabase:e2e\n');
}

main().catch((error: unknown) => {
  console.error('\nVerification error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
