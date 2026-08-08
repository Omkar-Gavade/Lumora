import { env } from '../../config/index.js';
import type { Logger } from '../../lib/logger.js';
import { ProviderError, type EmbeddingProvider } from '../../providers/embedding/embedding-provider.interface.js';
import { backoffDelayMs } from '../../repositories/job.repository.js';

/**
 * One text to embed, paired with whatever the caller needs to route the result
 * back.
 *
 * Generic in `T` so the service never learns what a chunk is. It batches,
 * retries, and returns vectors; the pipeline owns the mapping to database rows.
 */
export interface EmbeddingTask<T> {
  ref: T;
  text: string;
}

export interface EmbeddingResult<T> {
  ref: T;
  embedding: number[];
}

/**
 * Batched embedding with retry and partial-batch recovery
 * (docs/05-rag-and-chat.md §2.4).
 *
 * Three properties, each earning its complexity:
 *
 * **Batching (~96 per call).** One request per chunk turns a 500-chunk PDF
 * into 500 round trips against a rate-limited endpoint. The batch size is the
 * point where request size stops being the constraint and provider limits
 * start.
 *
 * **Sequential batches, not parallel.** §2.4 asks for "a bounded concurrency
 * limiter"; the bound here is one, and deliberately. Embedding throughput is
 * capped upstream by the provider's rate limit long before it is capped by
 * anything local (docs/06-roadmap.md R3), so parallel batches do not finish
 * sooner — they convert into 429s, which the retry path then serializes anyway
 * at a worse cost. Worker concurrency already provides parallelism *across*
 * documents, which is the axis that helps.
 *
 * **Per-batch retry, inside the job.** A single 429 should not fail a document
 * that is 80% embedded and hand it back to the queue, where the whole
 * remaining corpus is re-attempted after a minute's backoff. Retrying the one
 * batch costs seconds; failing the job costs the queue delay plus everything
 * already done that the resume query has to re-derive.
 */
export async function embedInBatches<T>(
  tasks: EmbeddingTask<T>[],
  provider: EmbeddingProvider,
  log: Logger,
  options: {
    batchSize?: number;
    maxRetries?: number;
    /** Called after each successful batch, so progress is durable mid-run. */
    onBatch?: (results: EmbeddingResult<T>[]) => Promise<void>;
    /** Overridable so tests do not sleep through a real backoff. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<EmbeddingResult<T>[]> {
  const batchSize = options.batchSize ?? env.EMBEDDING_BATCH_SIZE;
  const maxRetries = options.maxRetries ?? env.EMBEDDING_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;

  /*
    Empty and whitespace-only texts are dropped before batching (§2.4: "Empty
    and whitespace-only chunks are skipped").

    Not merely wasteful: several providers reject an empty string with a 400,
    which is non-retryable, so one blank chunk would dead-letter a document
    that is otherwise perfectly indexable.
  */
  const embeddable = tasks.filter((task) => task.text.trim().length > 0);
  const skipped = tasks.length - embeddable.length;
  if (skipped > 0) log.debug({ skipped }, 'Skipped empty chunks');

  const results: EmbeddingResult<T>[] = [];

  for (let start = 0; start < embeddable.length; start += batchSize) {
    const batch = embeddable.slice(start, start + batchSize);
    const batchNumber = Math.floor(start / batchSize) + 1;
    const batchCount = Math.ceil(embeddable.length / batchSize);

    const vectors = await embedWithRetry(
      batch.map((task) => task.text),
      provider,
      maxRetries,
      sleep,
      log.child({ batch: batchNumber, of: batchCount }),
    );

    const batchResults = batch.map((task, position) => ({
      ref: task.ref,
      // Positional pairing. Both adapters assert length and OpenAI's re-sorts
      // by the declared index, so the position is trustworthy by the time it
      // reaches here.
      embedding: vectors[position] ?? [],
    }));

    /*
      Persisted per batch rather than once at the end.

      This is what makes recovery *partial* rather than all-or-nothing. A
      worker killed after batch 4 of 6 leaves four batches durably recorded,
      and the resume query asks only for what is still missing. Holding every
      vector in memory until the end would mean a crash discards work that was
      already paid for.
    */
    await options.onBatch?.(batchResults);
    results.push(...batchResults);

    log.info(
      { batch: batchNumber, of: batchCount, embedded: results.length, total: embeddable.length },
      'Embedded batch',
    );
  }

  return results;
}

/**
 * One batch, retried on transient failures.
 *
 * The `retryable` flag decides. A 429 or a 503 is worth waiting out; a 401 or
 * a malformed request fails identically every time, and spending three
 * backoffs to confirm that keeps a document in `embedding` for minutes before
 * showing the user an error that was knowable immediately.
 */
async function embedWithRetry(
  texts: string[],
  provider: EmbeddingProvider,
  maxRetries: number,
  sleep: (ms: number) => Promise<void>,
  log: Logger,
): Promise<number[][]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const vectors = await provider.embed(texts);
      assertShape(vectors, texts.length, provider);
      return vectors;
    } catch (error) {
      lastError = error;

      const retryable = !(error instanceof ProviderError) || error.retryable;
      if (!retryable || attempt > maxRetries) break;

      // The same full-jitter schedule the job queue uses, for the same reason:
      // twenty jobs rate-limited at once must not all retry at the identical
      // instant and recreate the burst that caused it.
      const delay = backoffDelayMs(attempt);
      log.warn(
        { attempt, maxRetries, delayMs: delay, err: error },
        'Embedding batch failed — retrying',
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Verifies the provider returned what it promised.
 *
 * Dimension drift is the failure docs §2.4 singles out: "querying a
 * `text-embedding-3-small` index with a Gemini query vector returns confident
 * nonsense". It produces no error at write time and no error at read time —
 * only worse answers. Checking here is the single moment it is still cheap and
 * unambiguous.
 */
function assertShape(vectors: number[][], expected: number, provider: EmbeddingProvider): void {
  if (vectors.length !== expected) {
    throw new ProviderError(
      provider.name,
      `expected ${String(expected)} vectors, received ${String(vectors.length)}`,
      true,
    );
  }

  for (const [position, vector] of vectors.entries()) {
    if (vector.length !== provider.dimensions) {
      throw new ProviderError(
        provider.name,
        `vector ${String(position)} has ${String(vector.length)} dimensions, expected ${String(provider.dimensions)} — the model may have changed under an existing index`,
        // Not retryable: a dimension mismatch is a configuration fact, and no
        // number of attempts changes it.
        false,
      );
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never a reason to keep the process alive during shutdown.
    timer.unref();
  });
}

/**
 * A rough token count for usage accounting.
 *
 * Deliberately the same estimate the chunker uses, and deliberately **not**
 * used for billing — docs §2.4 records usage so cost is visible, and when a
 * provider returns its own count that is what gets stored. This is the
 * fallback for providers that do not report one.
 */
export function estimateBatchTokens(texts: string[]): number {
  return texts.reduce((total, text) => total + Math.ceil(text.length / 4), 0);
}
