import type {
  MetadataFilter,
  VectorMatch,
  VectorRecord,
  VectorStore,
} from './vector-store.interface.js';

/**
 * An in-memory `VectorStore`.
 *
 * Two jobs, and both are real rather than test scaffolding:
 *
 * 1. **The default in development and in the test suite.** Ingestion should be
 *    runnable and verifiable without a Chroma container. A pipeline that can
 *    only be exercised by starting a second service is a pipeline that stops
 *    being exercised.
 * 2. **It proves the interface holds against a second backend** — the same
 *    argument docs/06-roadmap.md R5 makes for the pgvector stub. An interface
 *    with exactly one implementation is a description of that implementation.
 *
 * Upsert semantics are enforced by keying on `record.id`, which is the
 * behaviour the pipeline's idempotency depends on. Getting that wrong here
 * would make every duplicate-prevention test pass against a store that does
 * not behave like the real one.
 */
export class FakeVectorStore implements VectorStore {
  readonly name = 'fake';

  private readonly collections = new Map<string, Map<string, VectorRecord>>();

  upsert(collection: string, records: VectorRecord[]): Promise<void> {
    const target = this.collections.get(collection) ?? new Map<string, VectorRecord>();
    this.collections.set(collection, target);

    // Keyed by id, so writing the same record twice leaves one copy — exactly
    // what Chroma's `upsert` does, and the property the retry path relies on.
    for (const record of records) target.set(record.id, record);

    return Promise.resolve();
  }

  query(
    collection: string,
    embedding: number[],
    k: number,
    filter?: MetadataFilter,
  ): Promise<VectorMatch[]> {
    const target = this.collections.get(collection);
    if (!target) return Promise.resolve([]);

    const matches = [...target.values()]
      .filter((record) => matchesFilter(record, filter))
      .map((record) => ({
        id: record.id,
        score: cosineSimilarity(embedding, record.embedding),
        text: record.text,
        metadata: record.metadata,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, k);

    return Promise.resolve(matches);
  }

  deleteByDocument(collection: string, documentId: string): Promise<void> {
    const target = this.collections.get(collection);
    if (!target) return Promise.resolve();

    for (const [id, record] of target) {
      if (record.metadata.documentId === documentId) target.delete(id);
    }

    return Promise.resolve();
  }

  deleteCollection(collection: string): Promise<void> {
    this.collections.delete(collection);
    return Promise.resolve();
  }

  health(): Promise<{ ok: boolean; latencyMs: number }> {
    return Promise.resolve({ ok: true, latencyMs: 0 });
  }

  // ── Test affordances ───────────────────────────────────────────────────────
  // Deliberately outside the interface: nothing in production may depend on
  // reading the index back, because the real store cannot answer these cheaply.

  /** Every record in a collection, for assertions about what was indexed. */
  recordsIn(collection: string): VectorRecord[] {
    return [...(this.collections.get(collection)?.values() ?? [])];
  }

  countIn(collection: string): number {
    return this.collections.get(collection)?.size ?? 0;
  }

  collectionNames(): string[] {
    return [...this.collections.keys()];
  }

  clear(): void {
    this.collections.clear();
  }
}

/**
 * The fake understands every operator the real store does.
 *
 * If it did not, a retrieval test written against the fake would pass while
 * the same filter changed nothing against Chroma — which is the precise shape
 * of bug the fake exists to catch rather than to hide.
 */
function matchesFilter(record: VectorRecord, filter?: MetadataFilter): boolean {
  if (!filter) return true;

  const metadata = record.metadata as unknown as Record<string, unknown>;

  return Object.entries(filter).every(([key, value]) => {
    const actual = metadata[key];

    // An `$in` over an empty list matches nothing, which is the correct
    // reading of "restricted to none of these" and mirrors Chroma.
    if (typeof value === 'object' && value !== null && '$in' in value) {
      return value.$in.some((candidate) => candidate === actual);
    }

    return actual === value;
  });
}

/**
 * Real cosine similarity, not a stub.
 *
 * Mirroring Chroma's ranking means a future retrieval test written against the
 * fake fails for the same reasons it would against the real store, instead of
 * passing because the fake returned insertion order.
 */
function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}
