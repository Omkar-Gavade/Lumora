import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './embedding-provider.interface.js';

/**
 * A deterministic embedding provider for tests and offline development.
 *
 * **Deterministic, not random.** The same text always produces the same
 * vector, which is what lets a test assert that a re-run of the pipeline
 * writes the same vectors rather than merely writing *some* vectors. A random
 * fake would make idempotency untestable — every rerun would differ, and the
 * one property the pipeline is built around could not be observed.
 *
 * The vectors carry no semantics and are not claimed to. They are unit-length
 * and well-distributed, which is everything the indexing path needs: it
 * validates dimensionality, batches, upserts, and counts. Nothing in M4b
 * measures similarity, so a fake that pretended to encode meaning would be
 * pretending for no test's benefit.
 *
 * `embedQuery` deliberately produces a *different* vector from `embed` for the
 * same text, mirroring the asymmetric models the interface exists for — so a
 * future retrieval test that accidentally embeds a query with the document
 * path fails loudly here rather than degrading recall silently in production.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  readonly model: string;
  readonly dimensions: number;

  /** Every call, for assertions about batching and retry behaviour. */
  readonly calls: { texts: string[]; kind: 'document' | 'query' }[] = [];

  /** Queued failures, shifted one per call. Drives retry and partial-batch tests. */
  private readonly failures: Error[] = [];

  constructor(options: { model?: string; dimensions?: number } = {}) {
    this.model = options.model ?? 'fake-embedding-001';
    this.dimensions = options.dimensions ?? 8;
  }

  /** Makes the next `count` calls throw `error`. */
  failNext(error: Error, count = 1): void {
    for (let index = 0; index < count; index += 1) this.failures.push(error);
  }

  reset(): void {
    this.calls.length = 0;
    this.failures.length = 0;
  }

  embed(texts: string[]): Promise<number[][]> {
    this.calls.push({ texts: [...texts], kind: 'document' });

    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);

    return Promise.resolve(texts.map((text) => this.vectorFor(`doc:${text}`)));
  }

  embedQuery(text: string): Promise<number[]> {
    this.calls.push({ texts: [text], kind: 'query' });

    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);

    return Promise.resolve(this.vectorFor(`query:${text}`));
  }

  /**
   * Derives a unit vector from a SHA-256 of the text.
   *
   * The hash is extended by counter suffixes when more bytes are needed than
   * one digest provides, so the provider works at any dimensionality rather
   * than silently capping at 32.
   */
  private vectorFor(text: string): number[] {
    const values: number[] = [];

    for (let round = 0; values.length < this.dimensions; round += 1) {
      const digest = createHash('sha256').update(`${text}#${String(round)}`).digest();
      for (const byte of digest) {
        if (values.length >= this.dimensions) break;
        // [0, 255] → [-1, 1]. Centred, so vectors are not all in one orthant.
        values.push((byte - 127.5) / 127.5);
      }
    }

    const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    // Guard against the (practically impossible) all-zero digest rather than
    // returning a vector of NaN that fails far from its cause.
    return magnitude === 0 ? values : values.map((value) => value / magnitude);
  }
}
