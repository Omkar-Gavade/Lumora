/**
 * Rebuilds the vector index for existing documents.
 *
 * **Why this exists as an operational command rather than an endpoint.**
 * Changing `EMBEDDING_MODEL` or `EMBEDDING_DIMENSIONS` invalidates every vector
 * already stored, and docs/05-rag-and-chat.md §2.4 says why the symptom is
 * dangerous: embedding spaces are not comparable across models, so the failure
 * is not an error but a quietly worse answer. M7 hit the sharp version of this
 * — an index written by the fake provider at 8 dimensions under a
 * configuration that had moved to Gemini at 768. Chroma rejected every query,
 * `Promise.allSettled` degraded to lexical-only, and retrieval looked like a
 * corpus with nothing to say.
 *
 * Recovering from that is a deliberate, whole-corpus operation an operator runs
 * once after changing the model. It is not a user action, so it is not an API.
 *
 * **What it deliberately does not do: touch Postgres content.** Documents,
 * chunk text, offsets, and section paths are all recomputed identically from
 * the same stored bytes, so deleting them would risk the source of truth to
 * rebuild a derived cache. Only two things are reset — the Chroma collection
 * and each chunk's `vector_id`, which is exactly the state that says "this
 * chunk has a live vector".
 *
 * Usage:
 *   npm run reindex -- --dry-run          # report what would change
 *   npm run reindex -- --user <email>     # one user
 *   npm run reindex -- --all              # every user with documents
 */
import { sql } from 'kysely';
import { db } from '../src/db/pool.js';
import { env } from '../src/config/index.js';
import { logger } from '../src/lib/logger.js';
import { embeddingProvider } from '../src/providers/embedding/embedding.factory.js';
import { vectorStore } from '../src/providers/vector/vector.factory.js';
import { collectionFor } from '../src/providers/vector/vector-store.interface.js';
import { JOB_TYPES } from '../src/domain/jobs/job-types.js';
import { jobRepository } from '../src/repositories/job.repository.js';

interface Options {
  dryRun: boolean;
  email: string | null;
  all: boolean;
}

function parseArgs(argv: string[]): Options {
  const emailIndex = argv.indexOf('--user');
  return {
    dryRun: argv.includes('--dry-run'),
    email: emailIndex === -1 ? null : (argv[emailIndex + 1] ?? null),
    all: argv.includes('--all'),
  };
}

/**
 * Confirms the configured provider actually produces the configured width
 * **before** anything is deleted.
 *
 * Reindexing is destructive to the index and slow to repeat, so discovering a
 * dimension mismatch afterwards means having thrown away a working-ish index to
 * build an equally broken one. One embedding call is a cheap way to refuse.
 */
async function assertProviderMatchesConfig(): Promise<void> {
  const probe = await embeddingProvider.embedQuery('dimension probe');

  if (probe.length !== env.EMBEDDING_DIMENSIONS) {
    throw new Error(
      `EMBEDDING_DIMENSIONS is ${String(env.EMBEDDING_DIMENSIONS)} but ` +
        `${embeddingProvider.name}/${embeddingProvider.model} returned ${String(probe.length)}. ` +
        `Fix the configuration before reindexing.`,
    );
  }

  logger.info(
    {
      provider: embeddingProvider.name,
      model: embeddingProvider.model,
      dimensions: probe.length,
    },
    'Embedding provider matches configuration',
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.all && options.email === null) {
    throw new Error('Specify --all or --user <email>. Refusing to guess.');
  }

  await assertProviderMatchesConfig();

  const targets = await db
    .selectFrom('documents')
    .innerJoin('users', 'users.id', 'documents.user_id')
    .select(['documents.user_id as userId', 'users.email as email'])
    .select(({ fn }) => fn.count<string>('documents.id').as('documentCount'))
    .$if(options.email !== null, (qb) => qb.where('users.email', '=', options.email ?? ''))
    .groupBy(['documents.user_id', 'users.email'])
    .execute();

  if (targets.length === 0) {
    logger.warn({}, 'No documents matched — nothing to do');
    return;
  }

  for (const target of targets) {
    const log = logger.child({ userId: target.userId });
    const collection = collectionFor(target.userId, env.CHROMA_COLLECTION_PREFIX);

    if (options.dryRun) {
      log.info(
        { email: target.email, documents: Number(target.documentCount), collection },
        'Would reindex',
      );
      continue;
    }

    /*
      Collection first, chunk markers second, jobs third.

      That order is the safe one under a crash. Dropping the collection leaves
      chunks pointing at vectors that no longer exist, which retrieval already
      tolerates — it is the state a failed embed leaves behind. The reverse
      order would leave chunks marked unembedded while their stale 8-dimension
      vectors are still live and still being returned, which is the exact
      failure being repaired.
    */
    await vectorStore.deleteCollection(collection);
    log.info({ collection }, 'Dropped vector collection');

    const cleared = await db.transaction().execute(async (trx) => {
      /*
        `vector_id = NULL` is what makes the embed stage see these chunks again
        (`findUnembedded` selects on exactly this), so this single column is the
        whole re-embed trigger. Chunk text is untouched.
      */
      const reset = await trx
        .updateTable('document_chunks')
        .set({ vector_id: null })
        .where('document_id', 'in', (qb) =>
          qb.selectFrom('documents').select('id').where('user_id', '=', target.userId),
        )
        .executeTakeFirst();

      /*
        Documents move to `queued` so the pipeline re-enters at the top. Parse
        and chunk are re-run rather than skipped even though only the embedding
        changed: both are idempotent by construction (§2.1 — `upsertMany`
        overwrites in place and `deleteFromIndex` removes any tail), and a
        rebuild that exercises the whole path is the one that proves the path.
      */
      await trx
        .updateTable('documents')
        .set({ status: 'queued', error_code: null, error_message: null, updated_at: sql`now()` })
        .where('user_id', '=', target.userId)
        .execute();

      const documents = await trx
        .selectFrom('documents')
        .select('id')
        .where('user_id', '=', target.userId)
        .execute();

      for (const document of documents) {
        await jobRepository.enqueue(
          JOB_TYPES.INGEST_DOCUMENT,
          { documentId: document.id, userId: target.userId },
          trx,
        );
      }

      return { chunks: Number(reset.numUpdatedRows), documents: documents.length };
    });

    log.info(
      { email: target.email, ...cleared },
      'Reindex queued — run the worker to drain it',
    );
  }
}

main()
  .then(() => db.destroy())
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Reindex failed');
    void db.destroy();
    process.exitCode = 1;
  });
