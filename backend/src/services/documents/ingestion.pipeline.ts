import { buffer as collectStream } from 'node:stream/consumers';
import type { DocumentStatus } from '@lumora/shared';
import { env } from '../../config/index.js';
import { STAGE_ENTRY_STATES, isTerminal } from '../../domain/jobs/document-status.js';
import type { Document } from '../../domain/entities/document.js';
import type { IngestDocumentPayload } from '../../domain/jobs/job-types.js';
import { logger, type Logger } from '../../lib/logger.js';
import { embeddingProvider } from '../../providers/embedding/embedding.factory.js';
import { storageProvider } from '../../providers/storage/storage.factory.js';
import { vectorStore } from '../../providers/vector/vector.factory.js';
import {
  collectionFor,
  vectorIdFor,
} from '../../providers/vector/vector-store.interface.js';
import { chunkRepository } from '../../repositories/chunk.repository.js';
import { documentRepository } from '../../repositories/document.repository.js';
import { usageRepository } from '../../repositories/usage.repository.js';
import { chunkDocument } from './chunking/chunker.js';
import { embedInBatches, estimateBatchTokens } from './embedding.service.js';
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
 * Runs a document through the full ingestion pipeline.
 *
 * docs/05-rag-and-chat.md §1: `queued → parsing → chunking → embedding →
 * ready`. Every transition is persisted, because FR-13 shows this sequence to
 * the user and an undifferentiated spinner is what makes a slow operation feel
 * stuck.
 *
 * **`ready` means exactly three things**: chunks persisted, embeddings
 * generated, vectors stored. Nothing else. It is set only after all three have
 * been observed, because `ready` promises a document that can be asked
 * questions — and one missing any of the three would answer none of them while
 * claiming otherwise.
 *
 * Every stage is re-runnable and resumes where it stopped. See the comment on
 * the resume decision below for why the stages are not equally cheap to redo.
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

  /*
    Resume at the stage the document is actually in.

    The whole pipeline is re-runnable, but the stages are not equally cheap:
    parsing costs CPU, chunking costs a few hundred upserts, and embedding
    costs money at a provider (docs/06-roadmap.md R3). A job retried after a
    crash late in the pipeline must not re-pay for the parts that already
    landed, and it must not walk the status backwards through transitions the
    state machine forbids.

    `embedding` needs no parse at all — chunk rows are already in Postgres, and
    `embedAndIndex` reads them from there.

    Unless they are not. A document in `embedding` with no chunk rows is a
    contradiction: the status says chunking finished, the table says it did
    not. It should not happen, but if it does the recoverable answer is to
    rebuild from the stored bytes, not to declare the document empty and fail
    it permanently — the file is intact, and only derived state was lost.
  */
  const existingChunks =
    document.status === 'embedding' ? await chunkRepository.countByDocument(documentId) : 0;
  const rebuilding = document.status === 'embedding' && existingChunks === 0;
  const needsParse = document.status !== 'embedding' || rebuilding;

  if (rebuilding) {
    log.warn({}, 'Document is embedding with no chunks — rebuilding from source');
  }

  let chunkCount: number;

  if (needsParse) {
    // ── Stage: parsing ───────────────────────────────────────────────────────
    /*
      Only transitioned when the document is genuinely at or before parsing. A
      document already in `chunking` stays there while it is re-chunked —
      moving it back to `parsing` would be a backwards transition, and the
      status the user is watching would appear to regress.
    */
    if (STAGE_ENTRY_STATES.parse.includes(document.status)) {
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
        Not a ParseError: storage was unreachable, the process ran out of
        memory, a dependency threw something unexpected. Rethrown so the worker
        retries with backoff, and the document stays where it is — a status the
        next attempt can legally pick back up.

        Marking it failed here would be wrong: the document is fine, the
        infrastructure was not, and burning the row on a transient outage is how
        a user loses a file to a thirty-second blip.
      */
      throw error;
    }

    // ── Stage: chunking ──────────────────────────────────────────────────────
    /*
      The rebuild path is the one place the pipeline moves a status backwards,
      and it is deliberate. A document sitting in `embedding` with no chunks
      cannot go forward — there is nothing to embed — and cannot stay, because
      nothing would ever fix it. Re-entering `chunking` is both the honest
      description of what is happening and the only exit.

      Kept out of `canTransition` on purpose: this is a repair, not a pipeline
      transition, and widening the state machine would legitimise the move
      everywhere rather than here.
    */
    const chunkEntry = rebuilding
      ? ([...STAGE_ENTRY_STATES.chunk, 'embedding'] as DocumentStatus[])
      : STAGE_ENTRY_STATES.chunk;

    const chunking = await documentRepository.transitionStatus(documentId, userId, {
      from: chunkEntry,
      to: 'chunking',
      pageCount: parsed.metadata.pageCount,
      tokenCount: estimateTokens(parsed.text),
    });

    if (chunking === null) {
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

    chunkCount = await persistChunks(document, parsed, log);
  } else {
    // Resuming mid-embedding: the chunks are the ones already committed.
    chunkCount = existingChunks;
    log.info({ chunkCount }, 'Resuming from embedding');
  }

  if (chunkCount === 0) {
    // Parsed to text but produced nothing indexable. A document with no chunks
    // is one that answers no question, and reporting it `ready` would promise
    // otherwise.
    await documentRepository.markFailed(
      documentId,
      userId,
      'EMPTY_CONTENT',
      'That file contains no readable text.',
    );
    return {
      kind: 'failed',
      code: 'EMPTY_CONTENT',
      message: 'That file contains no readable text.',
      retryable: false,
    };
  }

  // ── Stage: embedding ───────────────────────────────────────────────────────
  const embedding = await documentRepository.transitionStatus(documentId, userId, {
    from: STAGE_ENTRY_STATES.embed,
    to: 'embedding',
  });

  if (embedding === null) {
    log.info({}, 'Document moved on before embedding could start');
    return { kind: 'skipped', reason: 'already-processed' };
  }

  await embedAndIndex(document, log);

  // ── Stage: ready ───────────────────────────────────────────────────────────
  /*
    `ready` means exactly three things and nothing else: chunks persisted,
    embeddings generated, vectors stored. It is set only after all three have
    been observed — `embedAndIndex` throws rather than returning if any vector
    failed to land, so reaching this line is the proof.
  */
  const ready = await documentRepository.transitionStatus(documentId, userId, {
    from: ['embedding'],
    to: 'ready',
    chunkCount,
    embeddingModel: embeddingProvider.model,
    embeddingDims: embeddingProvider.dimensions,
    processedAt: new Date(),
  });

  if (ready === null) {
    log.info({}, 'Document moved on before it could be marked ready');
    return { kind: 'skipped', reason: 'already-processed' };
  }

  log.info(
    { chunkCount, model: embeddingProvider.model, dims: embeddingProvider.dimensions },
    'Document ready',
  );

  return { kind: 'advanced', status: 'ready' };
}

/**
 * Chunks the parsed document and writes the rows.
 *
 * Converges rather than accumulates. The chunker is deterministic, so a retry
 * produces byte-identical chunks; `upsertMany` overwrites in place, preserving
 * each row's id (which the vector store holds as `chunkId`); and
 * `deleteFromIndex` removes any surplus left by a previous run that produced
 * more chunks — a retuned `CHUNK_SIZE` or a fixed parser.
 *
 * Not wrapped in a transaction, deliberately. The upsert is idempotent and the
 * trailing delete is idempotent, so a crash between them leaves a state the
 * next attempt repairs. A transaction would hold write locks on several
 * hundred rows for the duration of chunking, and buy nothing that determinism
 * has not already bought.
 */
async function persistChunks(
  document: Document,
  parsed: ParsedDocument,
  log: Logger,
): Promise<number> {
  const chunks = chunkDocument(parsed, {
    targetTokens: env.CHUNK_SIZE,
    maxTokens: env.CHUNK_MAX_SIZE,
    minTokens: env.CHUNK_MIN_SIZE,
    overlapTokens: env.CHUNK_OVERLAP,
  });

  if (chunks.length === 0) return 0;

  await chunkRepository.upsertMany(
    chunks.map((chunk) => ({
      documentId: document.id,
      userId: document.userId,
      chunkIndex: chunk.index,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
      pageNumber: chunk.pageNumber,
      sectionPath: chunk.sectionPath,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
    })),
  );

  const removed = await chunkRepository.deleteFromIndex(document.id, chunks.length);
  if (removed > 0) {
    log.info({ removed }, 'Removed surplus chunks from a previous run');
  }

  log.info({ chunkCount: chunks.length }, 'Chunked');

  return chunks.length;
}

/**
 * Embeds every chunk that still lacks a vector and indexes the results.
 *
 * **The resume point.** It asks the database what is missing rather than
 * re-deriving it, so a job that died after 300 of 500 chunks costs the
 * remaining 200 — and embedding is the one step that costs real money
 * (docs/06-roadmap.md R3).
 *
 * Per batch, in this order:
 *   1. embed
 *   2. upsert vectors
 *   3. record `vector_id` on the chunk rows
 *
 * The ordering is load-bearing. A crash between 2 and 3 leaves chunks whose
 * vectors exist but are not recorded; the retry re-embeds and re-upserts them
 * under the same deterministic id, wasting one call but producing no duplicate.
 * The reverse order would mark chunks embedded whose vectors never landed, and
 * those passages would be permanently missing from the index while the
 * document reported `ready`.
 */
async function embedAndIndex(document: Document, log: Logger): Promise<void> {
  const pending = await chunkRepository.findUnembedded(document.id);

  if (pending.length === 0) {
    // Everything was already embedded by a previous attempt. Idempotent, and
    // the common case for a job retried after a crash late in the pipeline.
    log.info({}, 'All chunks already embedded');
    return;
  }

  const collection = collectionFor(document.userId, env.CHROMA_COLLECTION_PREFIX);

  /*
    Re-derives the enriched text rather than storing it.

    `content` is the passage; what gets embedded is the passage with its
    section path prepended (docs/05-rag-and-chat.md §2.3). Storing both would
    duplicate every chunk's text in Postgres to save a string concatenation,
    and would let the two drift.
  */
  const tasks = pending.map((chunk) => ({
    ref: chunk,
    text: chunk.sectionPath === null ? chunk.content : `${chunk.sectionPath}\n\n${chunk.content}`,
  }));

  let indexed = 0;

  await embedInBatches(tasks, embeddingProvider, log, {
    onBatch: async (results) => {
      const records = results.map(({ ref, embedding }) => ({
        id: vectorIdFor(document.id, ref.chunkIndex),
        embedding,
        text: ref.content,
        metadata: {
          chunkId: ref.id,
          documentId: document.id,
          userId: document.userId,
          documentName: document.filename,
          chunkIndex: ref.chunkIndex,
          pageNumber: ref.pageNumber,
          sectionPath: ref.sectionPath,
        },
      }));

      await vectorStore.upsert(collection, records);

      await chunkRepository.markEmbedded(
        records.map((record) => ({ chunkId: record.metadata.chunkId, vectorId: record.id })),
      );

      indexed += records.length;
    },
  });

  /*
    Usage is recorded once per document rather than once per batch.

    docs/06-roadmap.md R3 wants cost visible; one row per document is what
    makes "what did this file cost" a single lookup instead of a sum over
    however many batches its length happened to require.
  */
  await usageRepository.record({
    userId: document.userId,
    kind: 'embedding',
    model: embeddingProvider.model,
    inputTokens: estimateBatchTokens(tasks.map((task) => task.text)),
  });

  log.info({ indexed, collection }, 'Indexed vectors');
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
