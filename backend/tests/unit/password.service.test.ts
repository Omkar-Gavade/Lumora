import { describe, expect, it, vi } from 'vitest';

/*
  The breach checker is faked before the service imports it, so no test in this
  file reaches Have I Been Pwned. A suite that depends on a third party's
  uptime is a suite that fails for reasons unrelated to the code.
*/
const isBreached = vi.fn<(password: string) => Promise<boolean>>();

vi.mock('../../src/providers/breach/breach.factory.js', () => ({
  breachChecker: { name: 'fake', isBreached: (password: string) => isBreached(password) },
  createBreachChecker: () => ({ name: 'fake', isBreached }),
}));

const { passwordService } = await import('../../src/services/auth/password.service.js');
const { PasswordBreachedError } = await import('../../src/domain/errors/index.js');

const PASSWORD = 'Zt7qLmVx4Kdw';

describe('passwordService.hash', () => {
  it('produces an argon2id hash, never the password', async () => {
    const hash = await passwordService.hash(PASSWORD);

    // argon2**id** specifically: the hybrid resists both side-channel and
    // GPU-cracking attacks, and is what docs/00-product.md §7 specifies over
    // bcrypt.
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(PASSWORD);
  });

  it('salts, so the same password hashes differently every time', async () => {
    // Without a per-hash salt, identical passwords produce identical digests
    // and a single rainbow table breaks every account at once.
    const [first, second] = await Promise.all([
      passwordService.hash(PASSWORD),
      passwordService.hash(PASSWORD),
    ]);

    expect(first).not.toBe(second);
  });

  it('encodes the configured cost parameters', async () => {
    // OWASP's current recommended minimum: m=19456 KiB, t=2, p=1. Memory cost
    // is the parameter that matters — it buys silicon, which is what a
    // cracking rig scales.
    const hash = await passwordService.hash(PASSWORD);
    expect(hash).toContain('m=19456,t=2,p=1');
  });
});

describe('passwordService.verify', () => {
  it('accepts the correct password', async () => {
    const hash = await passwordService.hash(PASSWORD);
    expect(await passwordService.verify(hash, PASSWORD)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await passwordService.hash(PASSWORD);
    expect(await passwordService.verify(hash, 'WrongPassword123')).toBe(false);
  });

  it('is case-sensitive', async () => {
    const hash = await passwordService.hash(PASSWORD);
    expect(await passwordService.verify(hash, PASSWORD.toLowerCase())).toBe(false);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    // A corrupt row must not become a 500 that tells an attacker this
    // account's record is unusual.
    expect(await passwordService.verify('not-a-hash', PASSWORD)).toBe(false);
    expect(await passwordService.verify('', PASSWORD)).toBe(false);
  });
});

describe('passwordService.verifyDummy', () => {
  it('resolves without throwing, whatever it is given', async () => {
    // The login miss path calls this so a non-existent account costs the same
    // ~50ms a real verification does. If it threw, the miss path would answer
    // instantly and enumerate the user table by timing alone.
    await expect(passwordService.verifyDummy('anything')).resolves.toBeUndefined();
    await expect(passwordService.verifyDummy('')).resolves.toBeUndefined();
  });

  it('costs a comparable amount of time to a real verification', async () => {
    const hash = await passwordService.hash(PASSWORD);

    const realStart = process.hrtime.bigint();
    await passwordService.verify(hash, 'WrongPassword123');
    const realMs = Number((process.hrtime.bigint() - realStart) / 1_000_000n);

    const dummyStart = process.hrtime.bigint();
    await passwordService.verifyDummy('WrongPassword123');
    const dummyMs = Number((process.hrtime.bigint() - dummyStart) / 1_000_000n);

    // Wide band: this asserts "the expensive work happens", not a constant.
    expect(dummyMs).toBeGreaterThan(realMs * 0.4);
  });
});

describe('passwordService.assertNotBreached', () => {
  it('accepts a password absent from the corpus', async () => {
    isBreached.mockResolvedValueOnce(false);
    await expect(passwordService.assertNotBreached(PASSWORD)).resolves.toBeUndefined();
  });

  it('rejects a breached password with the documented error', async () => {
    // Not a policy failure but a factual one: the string is already in the
    // wordlists every credential-stuffing tool uses.
    isBreached.mockResolvedValueOnce(true);
    await expect(passwordService.assertNotBreached('password123')).rejects.toBeInstanceOf(
      PasswordBreachedError,
    );
  });

  it('passes the password to the checker unchanged', async () => {
    isBreached.mockResolvedValueOnce(false);
    await passwordService.assertNotBreached(PASSWORD);
    expect(isBreached).toHaveBeenCalledWith(PASSWORD);
  });
});
