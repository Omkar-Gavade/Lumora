import { JOB_PAYLOAD_SCHEMAS, JOB_TYPES, type JobType } from '../domain/jobs/job-types.js';
import { runIngestion } from '../services/documents/ingestion.pipeline.js';

/**
 * The outcome of running one job, in the terms the queue cares about.
 *
 * `retryable` is the only thing the worker needs from a handler beyond
 * success or failure: it decides between a backoff and an immediate dead
 * letter. A scanned PDF is not going to grow a text layer on the third
 * attempt, and spending two more retries — and several minutes of the user
 * staring at "processing" — to reconfirm that is worse than failing now.
 */
export type HandlerResult =
  | { ok: true }
  | { ok: false; error: string; retryable: boolean };

export type JobHandler = (payload: unknown) => Promise<HandlerResult>;

/**
 * Job type → handler (docs/03-backend.md §7).
 *
 * `satisfies Record<JobType, …>` rather than an index signature, so adding a
 * job type without a handler is a compile error. The alternative is a job that
 * enqueues cleanly, is claimed, finds no handler, and fails at runtime for a
 * reason nobody sees until a document sits in `queued` forever.
 *
 * Payloads are re-validated here even though `enqueue` validated them on the
 * way in. The two are separated by a database, by time, and possibly by a
 * deploy: the row a worker reads was written by a build that may no longer
 * exist, and trusting it is how a shape change turns into workers crashing on
 * rows they can neither interpret nor skip.
 */
export const JOB_HANDLERS = {
  [JOB_TYPES.INGEST_DOCUMENT]: async (payload: unknown): Promise<HandlerResult> => {
    const parsed = JOB_PAYLOAD_SCHEMAS[JOB_TYPES.INGEST_DOCUMENT].safeParse(payload);

    if (!parsed.success) {
      // Permanent by definition — the stored payload will not become valid.
      // Dead-lettering keeps the row, its payload, and this reason for
      // whoever has to work out where a malformed job came from.
      return {
        ok: false,
        error: `Invalid ingest_document payload: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
        retryable: false,
      };
    }

    const outcome = await runIngestion(parsed.data);

    if (outcome.kind === 'failed') {
      return {
        ok: false,
        error: `${outcome.code}: ${outcome.message}`,
        retryable: outcome.retryable,
      };
    }

    /*
      `advanced` and `skipped` are both successes.

      A skipped job did no work because there was none left to do — the
      document was deleted, or another attempt already advanced it. Reporting
      that as a failure would retry a no-op three times and then dead-letter a
      job that behaved correctly.
    */
    return { ok: true };
  },
} as const satisfies Record<JobType, JobHandler>;

export function handlerFor(type: string): JobHandler | null {
  return type in JOB_HANDLERS ? JOB_HANDLERS[type as JobType] : null;
}

/** The types this worker claims — everything it can actually run. */
export const HANDLED_JOB_TYPES = Object.keys(JOB_HANDLERS) as JobType[];
