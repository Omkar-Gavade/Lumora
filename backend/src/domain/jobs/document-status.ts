import type { DocumentStatus } from '@lumora/shared';

/**
 * The ingestion state machine (docs/05-rag-and-chat.md §1, FR-13).
 *
 * `queued → parsing → chunking → embedding → ready`, with `failed` reachable
 * from any working state. These six values are the whole vocabulary — the same
 * ones the `document_status` enum constrains and the ones FR-13 shows the user.
 *
 * Inspect, Extract, and Normalize are **stages inside parsing**, not statuses.
 * They exist in the parser's code path, they appear in structured logs, and
 * they are deliberately not persisted: a status the UI cannot label and the
 * enum does not contain would be a schema change bought for nothing.
 *
 * Encoding the transitions as data rather than as `if` statements scattered
 * through the pipeline is what makes the illegal ones — `ready → parsing`,
 * `failed → chunking` — impossible to write by accident, and testable without
 * running a job.
 */
const TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  queued: ['parsing', 'failed'],
  parsing: ['chunking', 'failed'],
  chunking: ['embedding', 'failed'],
  embedding: ['ready', 'failed'],
  /*
    Both terminal. `ready → *` is closed because a re-ingest is a new job over a
    reset row, not a live document sliding backwards while somebody is querying
    it; `failed → *` is closed because the retry path resets to `queued`
    explicitly rather than transitioning out of a terminal state.
  */
  ready: [],
  failed: [],
};

export function canTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The statuses a stage may legally start from.
 *
 * Two entries per stage, and the second is the one that matters. After a crash
 * the reaper returns the job to `pending` while the document row is still
 * sitting in the status its dead worker set — so `parsing` is a legal start
 * state for the parse stage, not just `queued`. Without that the retry would
 * refuse its own transition and the document would be stuck forever in a state
 * nothing can leave.
 *
 * This is why re-entry is safe rather than merely permitted: each stage
 * recomputes its output from the stored bytes and overwrites, so running it
 * twice produces the same row.
 */
export const STAGE_ENTRY_STATES: Record<'parse' | 'chunk' | 'embed', readonly DocumentStatus[]> = {
  parse: ['queued', 'parsing'],
  chunk: ['parsing', 'chunking'],
  embed: ['chunking', 'embedding'],
};

/** Statuses that mean the pipeline has nothing left to do for this document. */
export const TERMINAL_STATUSES: readonly DocumentStatus[] = ['ready', 'failed'];

export function isTerminal(status: DocumentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
