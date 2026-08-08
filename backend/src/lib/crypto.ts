import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OPAQUE_TOKEN_BYTES } from '../config/index.js';

/**
 * Opaque-token primitives.
 *
 * The pattern used for refresh, verification, and reset tokens is identical:
 * generate high-entropy random bytes, hand the encoding to the user, and store
 * only its hash. The database therefore never holds anything that can be
 * replayed — a dump yields hashes, and a hash is not a session.
 */

/**
 * base64url so the value is safe in a URL, a cookie, and a JSON body without
 * re-encoding. Standard base64 would need percent-encoding in a reset link and
 * would silently break on `+` becoming a space.
 */
export function generateOpaqueToken(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
}

/**
 * SHA-256, not Argon2 — and that is correct here, unlike for passwords.
 *
 * Argon2's cost exists to make guessing a low-entropy human secret expensive.
 * These tokens carry 256 bits of entropy, so guessing is already impossible
 * and a slow hash would only add latency to every refresh. What is needed is a
 * fast, preimage-resistant digest, which is exactly what SHA-256 is.
 */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison for hex digests.
 *
 * Lookups go through a UNIQUE index on the hash, so this is not on the primary
 * path — it exists for the places where two digests are compared in memory,
 * where `===` would leak position-of-first-difference through timing.
 */
export function safeEqualHex(a: string, b: string): boolean {
  // `timingSafeEqual` throws on length mismatch, which would itself be a
  // timing signal. Lengths are public for a fixed-width digest, so returning
  // early is safe.
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
