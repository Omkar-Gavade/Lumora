import { describe, expect, it } from 'vitest';
import { generateOpaqueToken, hashOpaqueToken, safeEqualHex } from '../../src/lib/crypto.js';

describe('generateOpaqueToken', () => {
  it('produces 256 bits of entropy, base64url encoded', () => {
    const token = generateOpaqueToken();

    // 32 bytes → 43 base64url characters, unpadded.
    expect(token).toHaveLength(43);
    // base64url so the value is safe in a URL, a cookie, and a JSON body
    // without re-encoding — standard base64 would break on `+` becoming a
    // space in a reset link.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 1_000 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(1_000);
  });
});

describe('hashOpaqueToken', () => {
  it('produces a stable SHA-256 hex digest', () => {
    expect(hashOpaqueToken('lumora')).toBe(hashOpaqueToken('lumora'));
    expect(hashOpaqueToken('lumora')).toHaveLength(64);
    expect(hashOpaqueToken('lumora')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is not reversible to the input', () => {
    expect(hashOpaqueToken('lumora')).not.toContain('lumora');
  });

  it('differs for inputs differing by one character', () => {
    expect(hashOpaqueToken('token-a')).not.toBe(hashOpaqueToken('token-b'));
  });
});

describe('safeEqualHex', () => {
  it('matches identical digests', () => {
    const digest = hashOpaqueToken('x');
    expect(safeEqualHex(digest, digest)).toBe(true);
  });

  it('rejects different digests', () => {
    expect(safeEqualHex(hashOpaqueToken('a'), hashOpaqueToken('b'))).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // `timingSafeEqual` throws on unequal lengths, which would itself be a
    // timing signal. Length is public for a fixed-width digest.
    expect(safeEqualHex('abcd', 'abcdef')).toBe(false);
  });
});
