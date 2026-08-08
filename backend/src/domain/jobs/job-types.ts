import { z } from 'zod';

/**
 * The job catalogue.
 *
 * One entry today. It exists as a registry rather than a bare string literal
 * because the worker in M4 dispatches on it, and a typo in a dispatch table
 * keyed by loose strings produces a job that enqueues successfully and is
 * never picked up — a failure with no error anywhere.
 */
export const JOB_TYPES = {
  /**
   * The entry point of the ingestion pipeline (docs/05-rag-and-chat.md §1).
   *
   * Enqueued in the same transaction as the `documents` row. From here M4
   * runs: parse → chunk → embed → index → ready.
   */
  INGEST_DOCUMENT: 'ingest_document',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/**
 * Payload schema for `ingest_document`.
 *
 * Deliberately minimal: identifiers only, never content. The document row is
 * the source of truth, so a job claimed an hour after it was enqueued reads
 * current state rather than a stale copy of it — which is also what makes a
 * retry idempotent.
 */
export const ingestDocumentPayloadSchema = z.object({
  documentId: z.uuid(),
  userId: z.uuid(),
});

export type IngestDocumentPayload = z.infer<typeof ingestDocumentPayloadSchema>;

/**
 * Payload schemas keyed by type.
 *
 * A payload is JSONB written by one process and read by another, possibly
 * running a different build. Validating on the way in means a worker can trust
 * what it reads; without it, a shape change produces workers crashing on rows
 * they can neither interpret nor skip.
 *
 * `satisfies` rather than an annotation, so adding a job type without a schema
 * is a compile error while each entry keeps its own precise type.
 */
export const JOB_PAYLOAD_SCHEMAS = {
  [JOB_TYPES.INGEST_DOCUMENT]: ingestDocumentPayloadSchema,
} as const satisfies Record<JobType, z.ZodType>;

/**
 * The ingestion stages, in order (docs/05-rag-and-chat.md §1).
 *
 * Named here — with nothing implementing them — so the pipeline's shape is a
 * fact in the codebase rather than a diagram in a document. M3 stops after
 * `queued`; each later stage moves `documents.status` to its own name, which
 * is what makes FR-13's live per-file status honest rather than a spinner.
 */
export const INGESTION_STAGES = ['parsing', 'chunking', 'embedding', 'ready'] as const;

export type IngestionStage = (typeof INGESTION_STAGES)[number];
