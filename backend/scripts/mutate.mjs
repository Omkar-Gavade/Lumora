/**
 * Mutation testing for the RAG invariants.
 *
 * Each entry breaks one invariant on purpose and runs the suites that should
 * notice. A mutation that survives is not a curiosity — it is a statement that
 * the invariant is unprotected, and the fix is a stronger test, never a weaker
 * assertion.
 *
 * Source files are restored from an in-memory copy in a `finally`, so an
 * interrupted run cannot leave a sabotaged tree behind.
 *
 *   node scripts/mutate.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'remove cosine floor filtering',
    file: 'src/services/retrieval/fusion.ts',
    from: 'return chunks.filter((chunk) => chunk.vectorScore === null || chunk.vectorScore >= floor);',
    to: 'return chunks;',
    tests: ['tests/unit/fusion.test.ts', 'tests/integration/rag-invariants.test.ts'],
  },
  {
    name: 'flip floor comparison direction',
    file: 'src/services/retrieval/fusion.ts',
    from: 'chunk.vectorScore === null || chunk.vectorScore >= floor',
    to: 'chunk.vectorScore === null || chunk.vectorScore <= floor',
    tests: ['tests/unit/fusion.test.ts', 'tests/integration/rag-invariants.test.ts'],
  },
  {
    name: 'bypass tenant isolation in vector retrieval',
    file: 'src/services/retrieval/vector.retriever.ts',
    from: 'collectionFor(query.userId, this.collectionPrefix)',
    to: "collectionFor('shared', this.collectionPrefix)",
    tests: ['tests/integration/retrieval.test.ts'],
  },
  {
    name: 'alter RRF ranking constant',
    file: 'src/services/retrieval/fusion.ts',
    from: '1 / (k + rank)',
    to: '1 / rank',
    tests: ['tests/unit/fusion.test.ts', 'tests/integration/rag-invariants.test.ts'],
  },
  {
    name: 'allow duplicate chunks through dedup',
    file: 'src/services/retrieval/retriever.interface.ts',
    from: '  return [...best.values()];',
    to: '  return chunks;',
    tests: ['tests/unit/fusion.test.ts', 'tests/integration/retrieval.test.ts'],
  },
  {
    name: 'disable vector→lexical degradation',
    file: 'src/services/retrieval/hybrid.retriever.ts',
    from: "  degraded.push(source);",
    to: '',
    tests: ['tests/integration/rag-invariants.test.ts'],
  },
  {
    name: 'bypass embedding dimension validation',
    file: 'src/services/documents/embedding.service.ts',
    from: 'if (vector.length !== provider.dimensions) {',
    to: 'if (false) {',
    tests: ['tests/unit/embedding.test.ts', 'tests/integration/indexing.test.ts'],
  },
  {
    name: 'break re-index idempotency (leave stale chunk tail)',
    file: 'src/services/documents/ingestion.pipeline.ts',
    from: 'await chunkRepository.deleteFromIndex(document.id, chunks.length);',
    to: 'await Promise.resolve();',
    tests: ['tests/integration/rag-invariants.test.ts', 'tests/integration/indexing.test.ts'],
  },
  {
    name: 'break vector deletion on document delete',
    file: 'src/services/documents/document.service.ts',
    from: 'await vectorStore.deleteByDocument(',
    to: 'await Promise.resolve(',
    tests: ['tests/integration/rag-invariants.test.ts', 'tests/integration/documents.test.ts'],
  },

  /*
    Worker invariants. These are the ones whose failure mode is a job that is
    silently lost or silently run twice — neither of which raises an error
    anywhere, and both of which corrupt a document's index rather than failing
    it visibly.
  */
  {
    name: 'worker: drop SKIP LOCKED (two workers can claim one job)',
    file: 'src/repositories/job.repository.ts',
    from: '            .skipLocked(),',
    to: '',
    tests: ['tests/integration/job-queue.test.ts'],
  },
  {
    name: 'worker: stop counting attempts on claim (poison job never dead-letters)',
    file: 'src/repositories/job.repository.ts',
    from: "        attempts: eb('attempts', '+', 1),",
    to: "        attempts: eb('attempts', '+', 0),",
    tests: ['tests/integration/job-queue.test.ts'],
  },
  {
    name: 'worker: ignore run_after (retry backoff becomes a hot loop)',
    file: 'src/repositories/job.repository.ts',
    from: "            .where('run_after', '<=', sql<Date>`now()`)",
    to: '',
    tests: ['tests/integration/job-queue.test.ts'],
  },

  /*
    Account-security invariants. Each of these is a silent takeover or a silent
    survival of a revoked session — nothing errors, and the endpoint keeps
    returning 200.
  */
  {
    name: 'security: skip current-password check on change',
    file: 'src/services/auth/user.service.ts',
    from: 'if (!(await passwordService.verify(user.passwordHash, currentPassword))) {',
    to: 'if (false) {',
    tests: ['tests/integration/users.test.ts'],
  },
  {
    name: 'security: skip password check on account deletion',
    file: 'src/services/auth/user.service.ts',
    from: 'if (!(await passwordService.verify(user.passwordHash, password))) {',
    to: 'if (false) {',
    tests: ['tests/integration/users.test.ts'],
  },
  {
    name: 'security: stop revoking sessions on password change',
    file: 'src/services/auth/user.service.ts',
    from: "      await refreshTokenRepository.revokeAllForUser(userId, 'password_change', trx);",
    to: '',
    tests: ['tests/integration/users.test.ts', 'tests/integration/auth-refresh.test.ts'],
  },
  {
    name: 'security: stop checking token_version (revocation becomes cosmetic)',
    file: 'src/api/middleware/authenticate.ts',
    from: 'if (current?.tokenVersion !== actor.tokenVersion) {',
    to: 'if (false) {',
    tests: ['tests/integration/users.test.ts', 'tests/integration/auth-logout.test.ts'],
  },
];

let caught = 0;
const survivors = [];

for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8');

  if (!original.includes(mutation.from)) {
    survivors.push(`${mutation.name} — ANCHOR NOT FOUND (mutation never applied)`);
    process.stdout.write(`  ??  ${mutation.name}  (anchor missing)\n`);
    continue;
  }

  try {
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
    execSync(`npx vitest run ${mutation.tests.join(' ')}`, { stdio: 'pipe' });
    // Exit 0 means every test passed with the invariant broken.
    survivors.push(mutation.name);
    process.stdout.write(`  SURVIVED  ${mutation.name}\n`);
  } catch {
    caught += 1;
    process.stdout.write(`  caught    ${mutation.name}\n`);
  } finally {
    writeFileSync(mutation.file, original);
  }
}

process.stdout.write(
  `\n${String(caught)}/${String(MUTATIONS.length)} caught\n` +
    (survivors.length > 0 ? `SURVIVORS:\n${survivors.map((s) => `  - ${s}`).join('\n')}\n` : ''),
);

process.exitCode = survivors.length > 0 ? 1 : 0;
