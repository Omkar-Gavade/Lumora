import { buffer as collectStream } from 'node:stream/consumers';
import type { DocumentStatus } from '@lumora/shared';
import { STAGE_ENTRY_STATES, isTerminal } from '../../domain/jobs/document-status.js';
import type { IngestDocumentPayload } from '../../domain/jobs/job-types.js';
import { logger, type Logger } from '../../lib/logger.js';
import { storageProvider } from '../../providers/storage/storage.factory.js';
import { documentRepository } from '../../repositories/document.repository.js';
import { estimateTokens } from './parsing/normalize.js';
import { ParseError, type ParsedDocument } from './parsing/parser.interface.js';
import { parserFor } from './parsing/parser.registry.js';

/**
 * What one run of the pipeline did, from the worker's point of view.
 *
 * `skipped` is a first-class outcome rather than a flavour of success because
 * the two have different causes worth seeing in logs: the document was already
 * past this stage, or it no longer exists. Both mean "complete the job", but
 * only one of them is normal.
 */
export type IngestionOutcome =
  | { kind: 'advanced'; status: DocumentStatus }
  | { kind: 'skipped'; reason: 'already-processed' | 'deleted' }
  | { kind: 'failed'; code: string; message: string; retryable: boolean };

/**
 * Runs a document through the stages this milestone implements.
 *
 * docs/05-rag-and-chat.md §1 defines the full path as
 * `queued → parsing → chunking → embedding → ready`. **M4a stops after
 * parsing.** The document is left in `chunking`, which is the honest
 * description of where it is: parsed, waiting for a chunker that does not exist
 * yet. It is deliberately not left in `ready` — `ready` promises a document you
 * can ask questions about, and one with no chunks would answer none of them.
 *
 * The function never throws for a document-level problem. A parse failure is a
 * value the worker acts on, because "this PDF is a scan" is an outcome to
 * record on the row, not an exception to propagate into a retry loop.
 * Infrastructure failures — storage down, database unreachable — do throw, and
 * the worker retries those.
 */
export async function runIngestion(payload: IngestDocumentPayload): Promise<IngestionOutcome> {
  const { documentId, userId } = payload;
  const log = logger.child({ documentId, userId, stage: 'ingest' });

  /*
    The document row is read fresh, never taken from the payload
    (docs/03-backend.md §7). A job claimed an hour after it was enqueued must
    see current state — including the possibility that the user deleted the
    document while it sat in the queue.
  */
  const document = await documentRepository.findById(documentId, userId);

  if (document === null) {
    // Deleting a document does not delete its queued job, and it should not:
    // that would mean a delete needs to reach into the queue and race with a
    // worker that may already hold the row. Tolerating the miss here is
    // simpler and strictly safer.
    log.info({}, 'Document no longer exists — dropping job');
    return { kind: 'skipped', reason: 'deleted' };
  }

  if (isTerminal(document.status)) {
    // A duplicate delivery, or a retry of a job whose previous attempt
    // succeeded but died before completing the row. Idempotency, not an error.
    log.info({ status: document.status }, 'Document already in a terminal state');
    return { kind: 'skipped', reason: 'already-processed' };
  }

  if (!STAGE_ENTRY_STATES.parse.includes(document.status)) {
    // Past parsing already — the document is waiting on a later stage that
    // this milestone does not implement.
    log.info({ status: document.status }, 'Document already parsed');
    return { kind: 'skipped', reason: 'already-processed' };
  }

  // ── Stage: parsing ─────────────────────────────────────────────────────────
  const claimed = await documentRepository.transitionStatus(documentId, userId, {
    from: STAGE_ENTRY_STATES.parse,
    to: 'parsing',
  });

  if (claimed === null) {
    // Another worker moved the row between the read above and this update.
    // Losing that race is the correct outcome for exactly one of the two.
    log.info({}, 'Lost the transition race — another worker owns this document');
    return { kind: 'skipped', reason: 'already-processed' };
  }

  let parsed: ParsedDocument;
  try {
    parsed = await parseDocument(document.mimeType, document.storageKey, log);
  } catch (error) {
    if (error instanceof ParseError) {
      await documentRepository.markFailed(documentId, userId, error.code, error.message);
      log.warn({ code: error.code, err: error }, 'Parsing failed');
      return {
        kind: 'failed',
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      };
    }

    /*
      Not a ParseError: storage was unreachable, the process ran out of memory,
      a dependency threw something unexpected. Rethrown so the worker retries
      with backoff, and the document stays in `parsing` — where the next attempt
      can legally pick it back up (STAGE_ENTRY_STATES.parse).

      Marking it failed here would be wrong: the document is fine, the
      infrastructure was not, and burning the row on a transient outage is how a
      user loses a file to a thirty-second blip.
    */
    throw error;
  }

  // ── Stage: chunking (entered, not performed) ───────────────────────────────
  const advanced = await documentRepository.transitionStatus(documentId, userId, {
    from: ['parsing'],
    to: 'chunking',
    pageCount: parsed.metadata.pageCount,
    tokenCount: estimateTokens(parsed.text),
  });

  if (advanced === null) {
    log.info({}, 'Document moved on before parsing could be recorded');
    return { kind: 'skipped', reason: 'already-processed' };
  }

  log.info(
    {
      pageCount: parsed.metadata.pageCount,
      characters: parsed.text.length,
      headings: parsed.headings.length,
    },
    'Parsed',
  );

  return { kind: 'advanced', status: 'chunking' };
}

/**
 * Inspect → Extract → Normalize (docs/05-rag-and-chat.md §2.2).
 *
 * The three internal stages the milestone brief asked to keep internal. Each
 * is logged at debug level so a stuck document can be traced to the step that
 * hung, without any of them becoming a persisted status the UI would have to
 * name.
 */
async function parseDocument(
  mimeType: string,
  storageKey: string,
  log: Logger,
): Promise<ParsedDocument> {
  // Inspect: resolve the parser before touching storage, so an unsupported
  // type fails without downloading 25 MB to find out.
  const parser = parserFor(mimeType);
  log.debug({ parser: parser.name, mimeType }, 'Inspected');

  /*
    The provider streams, and this collects the whole thing into memory.

    That is not a contradiction of the interface's reason for streaming — that
    exists so a download can be piped to a client without buffering. Parsing is
    the opposite case: both pdfjs and mammoth need random access to the entire
    container (a PDF's xref table lives at the end; a DOCX is a zip whose
    directory does too), so a streaming parse is not available at any price.
    The 25 MB upload cap is what makes this bounded, and `WORKER_CONCURRENCY`
    is what bounds the multiple.
  */
  const bytes = await collectStream(await storageProvider.get(storageKey));

  // Extract + Normalize both live inside the parser: normalization is applied
  // per format, because what counts as furniture in a PDF is not what counts as
  // noise in Markdown.
  const parsed = await parser.parse(bytes);

  if (parsed.text.trim().length === 0) {
    // Defensive. Every parser already raises EMPTY_CONTENT itself; this catches
    // a future parser that forgets to, rather than letting a document with no
    // text proceed to a chunker that would produce zero chunks and a `ready`
    // document that answers nothing.
    throw new ParseError('EMPTY_CONTENT', 'That file contains no readable text.');
  }

  log.debug(
    { pages: parsed.pages.length, characters: parsed.text.length },
    'Extracted and normalized',
  );

  return parsed;
}
