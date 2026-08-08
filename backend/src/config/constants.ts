import { PACKAGE_MANIFEST } from '../lib/paths.js';

/**
 * Fixed operational values — things that are the same in every environment and
 * therefore have no business being environment variables. A knob nobody turns
 * is a knob that gets set wrong.
 *
 * Domain limits (file sizes, chunk sizes, quotas, token TTLs) join this file
 * with the milestone that introduces them.
 */

/** Reported by `/health`. Single source of truth is the package manifest. */
export const APP_VERSION = PACKAGE_MANIFEST.version;

/**
 * Body limits (docs/03-backend.md §3). Small on purpose: every JSON endpoint in
 * Lumora carries a message or a form, and document bytes arrive as multipart on
 * a separate route with its own cap. A generous global limit only widens the
 * cheapest denial-of-service surface there is.
 */
export const JSON_BODY_LIMIT = '1mb';
export const URLENCODED_BODY_LIMIT = '1mb';

/** Inbound correlation id, honored so a trace survives a reverse proxy. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * An inbound request id is attacker-controlled and ends up in every log line
 * for that request, so it is length-capped and character-restricted. Without
 * this, a crafted header injects newlines into a log stream and forges entries.
 */
export const REQUEST_ID_MAX_LENGTH = 128;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * How long a shutdown waits for in-flight requests before forcing the process
 * down. Long enough for a normal request to finish, short enough to stay well
 * inside the grace period an orchestrator allows before it sends SIGKILL.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** A readiness check that has not answered in this long is a failed check. */
export const READINESS_TIMEOUT_MS = 2_000;

/*
  ── Authentication ──────────────────────────────────────────────────────────
  Constants, not environment variables: these are security parameters, and a
  knob that can be turned down in production without a code review is a knob
  that eventually is.
*/

/**
 * Argon2id parameters — OWASP's current recommended minimum
 * (m=19 MiB, t=2, p=1).
 *
 * Argon2**id**, not i or d: the hybrid resists both side-channel and
 * GPU-cracking attacks, and it is what docs/00-product.md §7 specifies over
 * bcrypt, whose 72-byte truncation and low memory cost make it the weaker
 * default now.
 *
 * Memory cost is the parameter that matters. Time cost buys linear work for an
 * attacker; memory cost buys silicon, and silicon is what a cracking rig
 * scales. Raising `timeCost` instead would slow honest logins by the same
 * factor while barely inconveniencing a GPU farm.
 */
export const ARGON2_MEMORY_COST_KIB = 19_456;
export const ARGON2_TIME_COST = 2;
export const ARGON2_PARALLELISM = 1;

/** Opaque token entropy. 32 bytes is 256 bits — not brute-forceable. */
export const OPAQUE_TOKEN_BYTES = 32;

/** docs/04-data-and-api.md §3.3. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Shorter than verification: a live reset link is a live account takeover. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Failed sign-ins tolerated before lockout begins (docs/04-data-and-api.md
 * §3.3). Five is high enough that a typo-prone human never notices and low
 * enough that online guessing is pointless.
 */
export const LOGIN_FAILURES_BEFORE_LOCKOUT = 5;
/** Doubles per failure past the threshold, to a ceiling. */
export const LOGIN_LOCKOUT_BASE_MS = 30 * 1000;
export const LOGIN_LOCKOUT_MAX_MS = 15 * 60 * 1000;

/** Refresh cookie path — scoped so it is not attached to ordinary API calls. */
export const REFRESH_COOKIE_NAME = 'lumora_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * How long the breach lookup may take before the password is allowed through.
 * Fail-open, deliberately: Have I Been Pwned being unreachable is not a reason
 * a user cannot create an account.
 */
export const BREACH_CHECK_TIMEOUT_MS = 1_500;
