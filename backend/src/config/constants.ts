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
