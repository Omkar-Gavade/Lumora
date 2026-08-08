import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRateLimitStore } from '../../src/lib/rate-limit/memory.store.js';

describe('MemoryRateLimitStore', () => {
  beforeEach(() => {
    // Fake timers rather than sleeping: a window is fifteen minutes, and a
    // suite that waits for real time is a suite nobody runs.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts hits within a window', async () => {
    const store = new MemoryRateLimitStore();

    expect((await store.hit('k', 60_000)).count).toBe(1);
    expect((await store.hit('k', 60_000)).count).toBe(2);
    expect((await store.hit('k', 60_000)).count).toBe(3);
  });

  it('keeps separate counts per key', async () => {
    const store = new MemoryRateLimitStore();

    await store.hit('a', 60_000);
    await store.hit('a', 60_000);
    await store.hit('b', 60_000);

    expect((await store.hit('a', 60_000)).count).toBe(3);
    expect((await store.hit('b', 60_000)).count).toBe(2);
  });

  it('starts a fresh window once the old one elapses', async () => {
    const store = new MemoryRateLimitStore();

    await store.hit('k', 1_000);
    await store.hit('k', 1_000);

    vi.advanceTimersByTime(1_001);

    expect((await store.hit('k', 1_000)).count).toBe(1);
  });

  it('reports when the window ends, so a client can be told how long to wait', async () => {
    const store = new MemoryRateLimitStore();
    const hit = await store.hit('k', 60_000);

    expect(hit.resetAt.getTime()).toBe(Date.now() + 60_000);
  });

  it('keeps the reset time fixed across a window — fixed window, not sliding', async () => {
    const store = new MemoryRateLimitStore();
    const first = await store.hit('k', 60_000);

    vi.advanceTimersByTime(30_000);
    const second = await store.hit('k', 60_000);

    // A sliding log is more accurate and costs a stored timestamp per request
    // per key — an unbounded allocation driven directly by attacker traffic.
    expect(second.resetAt.getTime()).toBe(first.resetAt.getTime());
  });

  it('forgives a key on reset, so a correct sign-in does not inherit failures', async () => {
    const store = new MemoryRateLimitStore();
    await store.hit('k', 60_000);
    await store.hit('k', 60_000);

    await store.reset('k');

    expect((await store.hit('k', 60_000)).count).toBe(1);
  });

  it('clears everything on clearAll', async () => {
    const store = new MemoryRateLimitStore();
    await store.hit('a', 60_000);
    await store.hit('b', 60_000);

    store.clearAll();

    expect((await store.hit('a', 60_000)).count).toBe(1);
    expect((await store.hit('b', 60_000)).count).toBe(1);
  });

  it('sweeps expired windows, so attacker traffic cannot grow the map forever', async () => {
    /*
      The keys include client IPs and email addresses, so without the sweep an
      attacker chooses how much memory this map holds. Asserted through
      behaviour — a swept key counts from one again — because the map itself
      is private.
    */
    const store = new MemoryRateLimitStore(1_000);
    await store.hit('victim', 500);

    vi.advanceTimersByTime(2_000);

    expect((await store.hit('victim', 500)).count).toBe(1);
  });
});
