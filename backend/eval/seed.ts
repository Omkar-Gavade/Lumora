/**
 * Seeds the evaluation corpus.
 *
 * **Why a dedicated corpus rather than a developer's own documents.**
 * docs/06-roadmap.md R1 calls retrieval quality the top project risk and names
 * "a hand-built evaluation set" as its mitigation — an artefact that has to
 * mean the same thing on every machine and after every reindex. Measuring
 * against whatever happens to be in someone's dev account produces numbers that
 * cannot be compared to yesterday's, which is the one property an evaluation
 * needs.
 *
 * The corpus is `docs/*.md`: real, substantial, in-repo, version-controlled
 * prose that every question in `dataset.json` can be checked against by reading
 * the file. Using the project's own specification documents also means the
 * expected evidence is verifiable by a reviewer without trusting me.
 *
 * The eval user is created fresh and its documents replaced on every run, so
 * the corpus is a function of the repository rather than of history.
 *
 *   npm run eval:seed
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../src/db/pool.js';
import { env } from '../src/config/index.js';
import { logger } from '../src/lib/logger.js';
import { embeddingProvider } from '../src/providers/embedding/embedding.factory.js';
import { documentService } from '../src/services/documents/document.service.js';
import { IngestionWorker } from '../src/workers/ingestion.worker.js';
import { EVAL_USER_EMAIL, REPO_DOCS_DIR, evalUserId } from './shared.js';

async function main(): Promise<void> {
  /*
    The same pre-flight the reindex script runs, for the same reason: an
    evaluation embedded at the wrong width measures a broken index and reports
    it as poor retrieval quality, which is the most misleading number this
    harness could produce.
  */
  const probe = await embeddingProvider.embedQuery('dimension probe');
  if (probe.length !== env.EMBEDDING_DIMENSIONS) {
    throw new Error(
      `EMBEDDING_DIMENSIONS is ${String(env.EMBEDDING_DIMENSIONS)} but ` +
        `${embeddingProvider.name} returned ${String(probe.length)}.`,
    );
  }

  const userId = await evalUserId();
  logger.info(
    { userId, email: EVAL_USER_EMAIL, provider: embeddingProvider.name, dimensions: probe.length },
    'Eval user ready',
  );

  // Replace rather than append: a second run must not double the corpus and
  // quietly halve every recall number.
  const existing = await documentService.list(userId, { limit: 100 });
  for (const document of existing.items) {
    await documentService.delete(userId, document.id);
  }
  logger.info({ removed: existing.items.length }, 'Cleared previous eval corpus');

  const names = (await readdir(REPO_DOCS_DIR)).filter((name) => name.endsWith('.md')).sort();

  const files = await Promise.all(
    names.map(async (name) => ({
      originalname: name,
      mimetype: 'text/markdown',
      buffer: await readFile(join(REPO_DOCS_DIR, name)),
    })),
  );

  const result = await documentService.upload(userId, files);
  logger.info(
    { accepted: result.accepted.length, rejected: result.rejected.length },
    'Corpus uploaded',
  );
  for (const rejection of result.rejected) {
    logger.warn({ file: rejection.filename, code: rejection.code, reason: rejection.message }, 'Rejected');
  }

  // Driven explicitly rather than by the background poller, so seeding is
  // finished when this process exits instead of "probably finished soon".
  await new IngestionWorker({ workerId: 'eval-seed', concurrency: 2 }).drain();

  const final = await documentService.list(userId, { limit: 100 });
  const ready = final.items.filter((document) => document.status === 'ready');
  logger.info(
    {
      documents: final.items.length,
      ready: ready.length,
      chunks: ready.reduce((total, document) => total + (document.chunkCount ?? 0), 0),
    },
    'Eval corpus indexed',
  );

  for (const document of final.items) {
    if (document.status !== 'ready') {
      logger.error({ file: document.filename, status: document.status }, 'Not ready');
    }
  }
}

main()
  .then(() => db.destroy())
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Eval seed failed');
    void db.destroy();
    process.exitCode = 1;
  });
