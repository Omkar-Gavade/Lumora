import { describe, expect, it } from 'vitest';
import type { DocumentStatus } from '@lumora/shared';
import {
  STAGE_ENTRY_STATES,
  TERMINAL_STATUSES,
  canTransition,
  isTerminal,
} from '../../src/domain/jobs/document-status.js';
import { backoffDelayMs } from '../../src/repositories/job.repository.js';

const ALL_STATUSES: DocumentStatus[] = [
  'queued',
  'parsing',
  'chunking',
  'embedding',
  'ready',
  'failed',
];

describe('document status machine', () => {
  it('walks the documented happy path', () => {
    // docs/05-rag-and-chat.md §1. FR-13 shows exactly this sequence to users.
    // Written as explicit pairs rather than a windowed loop, so the assertion
    // reads as the documented sequence rather than as index arithmetic.
    const steps: [DocumentStatus, DocumentStatus][] = [
      ['queued', 'parsing'],
      ['parsing', 'chunking'],
      ['chunking', 'embedding'],
      ['embedding', 'ready'],
    ];

    for (const [from, to] of steps) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('allows failure from every working state', () => {
    for (const status of ALL_STATUSES.filter((value) => !isTerminal(value))) {
      expect(canTransition(status, 'failed')).toBe(true);
    }
  });

  it('never leaves a terminal state', () => {
    // A late-finishing duplicate worker must not drag a `ready` document
    // backwards while somebody is querying it.
    for (const terminal of TERMINAL_STATUSES) {
      for (const target of ALL_STATUSES) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('forbids skipping a stage', () => {
    expect(canTransition('queued', 'chunking')).toBe(false);
    expect(canTransition('queued', 'ready')).toBe(false);
    expect(canTransition('parsing', 'embedding')).toBe(false);
  });

  it('forbids moving backwards', () => {
    expect(canTransition('chunking', 'parsing')).toBe(false);
    expect(canTransition('embedding', 'queued')).toBe(false);
  });

  it('is exhaustive — every status has a rule', () => {
    // A status missing from the table would throw on lookup rather than
    // returning false, turning a state-machine gap into a crashed worker.
    for (const from of ALL_STATUSES) {
      expect(() => canTransition(from, 'failed')).not.toThrow();
    }
  });
});

describe('stage entry states', () => {
  it('lets a stage re-enter from its own status, which is what makes crash recovery work', () => {
    // After a crash the reaper requeues the job while the row still sits in the
    // status the dead worker set. Without this the retry would refuse its own
    // transition and the document would be stuck forever.
    expect(STAGE_ENTRY_STATES.parse).toContain('parsing');
    expect(STAGE_ENTRY_STATES.chunk).toContain('chunking');
    expect(STAGE_ENTRY_STATES.embed).toContain('embedding');
  });

  it('starts each stage from the status the previous one leaves behind', () => {
    expect(STAGE_ENTRY_STATES.parse).toContain('queued');
    expect(STAGE_ENTRY_STATES.chunk).toContain('parsing');
    expect(STAGE_ENTRY_STATES.embed).toContain('chunking');
  });

  it('never admits a terminal status as an entry state', () => {
    for (const states of Object.values(STAGE_ENTRY_STATES)) {
      for (const status of states) {
        expect(isTerminal(status)).toBe(false);
      }
    }
  });
});

describe('backoffDelayMs', () => {
  it('grows the ceiling exponentially with attempts', () => {
    // Sampled, because full jitter makes any single draw uninformative. The
    // maximum over many draws approximates the ceiling.
    const ceilingFor = (attempts: number): number =>
      Math.max(...Array.from({ length: 500 }, () => backoffDelayMs(attempts, 1_000)));

    expect(ceilingFor(1)).toBeLessThanOrEqual(1_000);
    expect(ceilingFor(2)).toBeGreaterThan(1_000);
    expect(ceilingFor(2)).toBeLessThanOrEqual(2_000);
    expect(ceilingFor(4)).toBeGreaterThan(4_000);
    expect(ceilingFor(4)).toBeLessThanOrEqual(8_000);
  });

  it('caps the delay, so a late attempt is not scheduled for tomorrow', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(backoffDelayMs(20, 1_000, 5 * 60_000)).toBeLessThanOrEqual(5 * 60_000);
    }
  });

  it('never returns a negative delay, even for a nonsensical attempt count', () => {
    expect(backoffDelayMs(0)).toBeGreaterThanOrEqual(0);
    expect(backoffDelayMs(-5)).toBeGreaterThanOrEqual(0);
  });

  it('spreads retries instead of reproducing the burst that caused the failure', () => {
    /*
      This is the property that matters, and the one a bare exponential
      schedule lacks. When a provider 429s twenty concurrent jobs, an
      unjittered schedule retries all twenty at the identical instant and
      recreates the rate limit.

      Asserted as distinct values rather than a distribution test: full jitter
      over [0, 8000) making 100 draws collide into fewer than 50 buckets is
      effectively impossible, while a stubbed-out jitter would produce exactly
      one.
    */
    const draws = new Set(Array.from({ length: 100 }, () => backoffDelayMs(4, 1_000)));

    expect(draws.size).toBeGreaterThan(50);
  });
});
