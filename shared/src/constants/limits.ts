/**
 * Numeric limits both halves must agree on.
 *
 * A password rule enforced only on the server rejects a form the client just
 * told the user was fine; enforced only on the client it is not enforced at
 * all. These live here so there is exactly one number.
 */

/**
 * docs/00-product.md §8: "min 12 chars, not a known-breached password".
 * Length over composition rules — a 12-character passphrase beats an
 * 8-character one with a symbol bolted on, and NIST dropped mandatory
 * composition for exactly that reason.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Argon2id accepts arbitrary length, but an unbounded password is an
 * unbounded amount of memory-hard hashing per request — a trivially cheap way
 * to exhaust a server.
 */
export const PASSWORD_MAX_LENGTH = 128;

/** RFC 5321 caps the whole address at 254 octets. */
export const EMAIL_MAX_LENGTH = 254;

export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 80;

/**
 * Seconds a client must wait before asking for another verification email.
 * Mirrored by the server (docs/04-data-and-api.md §2.1) so the button's
 * countdown and the endpoint's answer agree.
 */
export const RESEND_COOLDOWN_SECONDS = 60;
