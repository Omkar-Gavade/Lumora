/**
 * The retrieval evaluation harness (docs/06-roadmap.md R1).
 *
 * **One retrieval pass, many thresholds.** Each case is retrieved exactly once
 * with the floor open, and every fused candidate is captured with its score.
 * Candidate thresholds are then applied to that captured list offline. This is
 * not an optimisation — it is what makes the sweep *correct*: the floor is
 * applied after fusion, so re-running retrieval per threshold would produce the
 * same candidates and differ only in noise, while spending one Gemini embedding
 * call per case per threshold. On a free tier that is the difference between a
 * sweep that runs and a sweep that 429s halfway through.
 *
 *   npm run eval
 *   npm run eval -- --k 5
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { db } from '../src/db/pool.js';
import { env } from '../src/config/index.js';
import { logger } from '../src/lib/logger.js';
import { embeddingProvider } from '../src/providers/embedding/embedding.factory.js';
import { vectorStore } from '../src/providers/vector/vector.factory.js';
import { HybridRetriever } from '../src/services/retrieval/hybrid.retriever.js';
import { VectorRetriever } from '../src/services/retrieval/vector.retriever.js';
import { Bm25Retriever } from '../src/services/retrieval/bm25.retriever.js';
import { documentService } from '../src/services/documents/document.service.js';
import { PACKAGE_ROOT } from '../src/lib/paths.js';
import { evalUserId } from './shared.js';

interface Case {
  id: string;
  kind: string;
  query: string;
  expectedDocuments: string[];
  expectAbstain: boolean;
}

interface Candidate {
  documentName: string;
  chunkId: string;
  /** Fused RRF score — used for ordering only. */
  score: number;
  /**
   * Cosine similarity from the vector half, or null for a lexical-only hit.
   *
   * **This is the field the relevance floor actually compares against**
   * (`applyRelevanceFloor` filters on `vectorScore`, not on the fused score).
   * An earlier version of this harness swept the fused score and produced a
   * sweep that described behaviour the code does not have.
   */
  vectorScore: number | null;
}

interface CaseResult {
  id: string;
  kind: string;
  query: string;
  expectedDocuments: string[];
  expectAbstain: boolean;
  candidates: Candidate[];
  vectorCandidates: number;
  lexicalCandidates: number;
  degraded: string[];
  retrievalMs: number;
  error: string | null;
}

const dataset = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'eval', 'dataset.json'), 'utf8'),
) as { version: number; cases: Case[] };

/** Rank position of the first candidate from an expected document, or -1. */
function firstExpectedRank(result: CaseResult, candidates: Candidate[]): number {
  return candidates.findIndex((candidate) =>
    result.expectedDocuments.includes(candidate.documentName),
  );
}

/**
 * Scores one threshold against every case.
 *
 * `recallAtK` counts only answerable cases — a case expected to abstain has no
 * evidence to recall, and including it would let a threshold that abstains on
 * everything score well on recall.
 */
function evaluateThreshold(results: CaseResult[], threshold: number, k: number) {
  let answerable = 0;
  let recalled = 0;
  let abstainCorrect = 0;
  let abstainTotal = 0;
  let falseAbstain = 0;
  const failures: string[] = [];

  for (const result of results) {
    /*
      Mirrors `applyRelevanceFloor` exactly, including the null bypass: a
      lexical-only hit has no cosine score and is never filtered. Reimplementing
      the predicate differently here would measure a system that does not exist.
    */
    const surviving = result.candidates.filter(
      (candidate) => candidate.vectorScore === null || candidate.vectorScore >= threshold,
    );
    const abstained = surviving.length === 0;

    if (result.expectAbstain) {
      abstainTotal += 1;
      if (abstained) abstainCorrect += 1;
      else failures.push(`${result.id}: answered when it should have abstained`);
      continue;
    }

    answerable += 1;
    if (abstained) {
      falseAbstain += 1;
      failures.push(`${result.id}: abstained on an answerable question`);
      continue;
    }

    const rank = firstExpectedRank(result, surviving.slice(0, k));
    if (rank !== -1) recalled += 1;
    else failures.push(`${result.id}: expected evidence not in top ${String(k)}`);
  }

  return {
    threshold,
    recallAtK: answerable === 0 ? 0 : recalled / answerable,
    abstentionAccuracy: abstainTotal === 0 ? 0 : abstainCorrect / abstainTotal,
    falseAbstentions: falseAbstain,
    answerable,
    abstainTotal,
    failures,
  };
}

async function main(): Promise<void> {
  const kIndex = process.argv.indexOf('--k');
  const k = kIndex === -1 ? 5 : Number(process.argv[kIndex + 1] ?? 5);

  const userId = await evalUserId();
  const documents = await documentService.list(userId, { limit: 100 });
  const ready = documents.items.filter((document) => document.status === 'ready');

  if (ready.length === 0) throw new Error('No indexed documents. Run npm run eval:seed first.');

  logger.info(
    {
      documents: ready.length,
      chunks: ready.reduce((total, d) => total + (d.chunkCount ?? 0), 0),
      cases: dataset.cases.length,
      provider: embeddingProvider.name,
      model: embeddingProvider.model,
      dimensions: env.EMBEDDING_DIMENSIONS,
    },
    'Evaluation starting',
  );

  const retriever = new HybridRetriever(
    new VectorRetriever(vectorStore, embeddingProvider),
    new Bm25Retriever(),
  );

  const results: CaseResult[] = [];

  for (const testCase of dataset.cases) {
    const startedAt = Date.now();
    try {
      /*
        Floor wide open and a deliberately large result cap: this pass is
        *capture*, not selection. Filtering here would throw away exactly the
        low-scoring candidates the sweep needs in order to say what a threshold
        would have discarded.
      */
      const outcome = await retriever.retrieve(
        { userId, text: testCase.query, topK: 20 },
        logger,
        { relevanceFloor: -1, maxResults: 20, maxPerDocument: 20 },
      );

      results.push({
        id: testCase.id,
        kind: testCase.kind,
        query: testCase.query,
        expectedDocuments: testCase.expectedDocuments,
        expectAbstain: testCase.expectAbstain,
        candidates: outcome.chunks.map((chunk) => ({
          documentName: chunk.documentTitle,
          chunkId: chunk.chunkId,
          score: chunk.score,
          vectorScore: chunk.vectorScore,
        })),
        vectorCandidates: outcome.stats.vectorCandidates,
        lexicalCandidates: outcome.stats.lexicalCandidates,
        degraded: outcome.stats.degraded,
        retrievalMs: Date.now() - startedAt,
        error: null,
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        kind: testCase.kind,
        query: testCase.query,
        expectedDocuments: testCase.expectedDocuments,
        expectAbstain: testCase.expectAbstain,
        candidates: [],
        vectorCandidates: 0,
        lexicalCandidates: 0,
        degraded: ['exception'],
        retrievalMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /*
    Candidate thresholds are derived from the observed score distribution, not
    picked from intuition.

    This matters more than it looks: the floor is applied to the **fused RRF**
    score, not to cosine similarity. RRF scores are 1/(60+rank) summed over at
    most two retrievers, so they live in roughly [0.008, 0.033] — nowhere near
    the [-1, 1] cosine range `RETRIEVAL_MIN_SCORE` is validated against. A
    threshold chosen by cosine intuition (say 0.5) would discard every chunk in
    the corpus, every time.
  */
  const allScores = results
    .flatMap((result) =>
      result.candidates
        .map((candidate) => candidate.vectorScore)
        .filter((score): score is number => score !== null),
    )
    .sort((a, b) => a - b);

  const percentile = (p: number): number =>
    allScores.length === 0 ? 0 : (allScores[Math.floor((allScores.length - 1) * p)] ?? 0);

  const thresholds = [
    -1,
    percentile(0.1),
    percentile(0.25),
    percentile(0.5),
    percentile(0.75),
    percentile(0.9),
  ];

  const sweep = thresholds.map((threshold) => evaluateThreshold(results, threshold, k));

  const latencies = results.map((result) => result.retrievalMs).sort((a, b) => a - b);
  const at = (p: number): number => latencies[Math.floor((latencies.length - 1) * p)] ?? 0;

  const report = {
    version: dataset.version,
    generatedAt: new Date().toISOString(),
    k,
    corpus: {
      documents: ready.length,
      chunks: ready.reduce((total, d) => total + (d.chunkCount ?? 0), 0),
      names: ready.map((d) => d.filename).sort(),
    },
    provider: {
      embedding: embeddingProvider.name,
      model: embeddingProvider.model,
      dimensions: env.EMBEDDING_DIMENSIONS,
      vectorStore: vectorStore.name,
    },
    cases: results.length,
    latencyMs: { p50: at(0.5), p95: at(0.95), max: at(1) },
    scoreRange: {
      min: allScores[0] ?? 0,
      max: allScores.at(-1) ?? 0,
      note: 'Cosine similarity from the vector half — the field RETRIEVAL_MIN_SCORE is compared against.',
    },
    /*
      Generation-side metrics are declared and explicitly not measured rather
      than silently omitted. Citation precision, citation coverage, and
      groundedness all require calling the LLM once per case; the harness does
      not do that yet, and reporting a zero would read as a failing score
      instead of an absent one.
    */
    notMeasured: {
      citationPrecision: 'requires generation — not implemented',
      citationCoverage: 'requires generation — not implemented',
      groundedness: 'requires generation — not implemented',
    },
    sweep,
    results,
  };

  const outputPath = join(PACKAGE_ROOT, 'eval', 'report.json');
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  const degradedCases = results.filter((result) => result.degraded.length > 0);
  const errored = results.filter((result) => result.error !== null);

  process.stdout.write(
    [
      '',
      `Corpus:     ${String(report.corpus.documents)} documents, ${String(report.corpus.chunks)} chunks`,
      `Provider:   ${report.provider.embedding}/${report.provider.model} @ ${String(report.provider.dimensions)}d → ${report.provider.vectorStore}`,
      `Cases:      ${String(results.length)}  (answerable ${String(sweep[0]?.answerable ?? 0)}, abstain-expected ${String(sweep[0]?.abstainTotal ?? 0)})`,
      `Latency:    p50 ${String(report.latencyMs.p50)}ms  p95 ${String(report.latencyMs.p95)}ms`,
      `Cosine:     ${report.scoreRange.min.toFixed(4)} … ${report.scoreRange.max.toFixed(4)}`,
      `Degraded:   ${String(degradedCases.length)}   Errors: ${String(errored.length)}`,
      '',
      `  threshold      recall@${String(k)}   abstention   false-abstain`,
      ...sweep.map(
        (row) =>
          `  ${row.threshold.toFixed(5).padStart(9)}   ${(row.recallAtK * 100).toFixed(1).padStart(7)}%   ${(row.abstentionAccuracy * 100).toFixed(1).padStart(9)}%   ${String(row.falseAbstentions).padStart(13)}`,
      ),
      '',
      `Report: ${outputPath}`,
      '',
    ].join('\n'),
  );
}

main()
  .then(() => db.destroy())
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Evaluation failed');
    void db.destroy();
    process.exitCode = 1;
  });
