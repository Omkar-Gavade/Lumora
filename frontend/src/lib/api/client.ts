import { ERROR_CODES } from '@lumora/shared';
import { env } from '@/app/config/env';
import { ApiError, toApiError } from './errors';

const API_PREFIX = '/api/v1';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The access token lives in a module variable, not in React state and never in
 * `localStorage` (docs/02-frontend.md §5.2, docs/04-data-and-api.md §3.1).
 *
 * Not `localStorage`: any XSS reads it synchronously and exfiltrates it, and a
 * token there outlives the tab. In memory it dies with the page and is not
 * reachable by a script that runs before the app initializes.
 *
 * Not React state: a token refresh would re-render every consumer of the auth
 * context, several times a session, for a value no component renders.
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Called when a refresh fails terminally. Set by `AuthProvider` so the
 * interceptor can clear session state without importing React.
 */
let onSessionExpired: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skips the Authorization header and the refresh-and-retry path. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

/**
 * Single-flight refresh (docs/02-frontend.md §6.1).
 *
 * **This promise is the whole mechanism.** Without it, five concurrent
 * requests that all 401 fire five refreshes; because refresh tokens rotate,
 * four of them present an already-consumed token, trip the server's reuse
 * detection, and revoke the family — signing the user out. That is the exact
 * bug that makes hand-rolled refresh notorious, and it is a *client* bug that
 * looks like a server one.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${env.VITE_API_URL}${API_PREFIX}/auth/refresh`, {
        method: 'POST',
        // The refresh cookie is httpOnly and path-scoped; `include` is what
        // attaches it cross-origin.
        credentials: 'include',
      });

      if (!response.ok) return false;

      const session = (await response.json()) as { accessToken?: unknown };
      if (typeof session.accessToken !== 'string') return false;

      accessToken = session.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared in `finally` so a rejected refresh cannot wedge every
      // subsequent request behind a permanently settled failure.
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function execute(path: string, options: RequestOptions): Promise<Response> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (!options.anonymous && accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  return fetch(`${env.VITE_API_URL}${API_PREFIX}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * Performs a request, refreshing once on an expired access token.
 *
 * Retry is attempted **exactly once**. A second 401 after a successful refresh
 * is a real authorization failure, not an expiry, and retrying again would
 * loop forever against an endpoint the user simply cannot reach.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;

  try {
    response = await execute(path, options);
  } catch {
    throw ApiError.network();
  }

  if (response.status === 401 && !options.anonymous) {
    const error = await toApiError(response.clone());

    // Only expiry is retryable. `TOKEN_REUSED` or `TOKEN_INVALID` mean the
    // session is gone, and refreshing would be one more replay.
    if (error.is(ERROR_CODES.TOKEN_EXPIRED)) {
      if (await refreshSession()) {
        try {
          response = await execute(path, options);
        } catch {
          throw ApiError.network();
        }
      } else {
        accessToken = null;
        onSessionExpired?.();
        throw error;
      }
    }
  }

  if (!response.ok) throw await toApiError(response);

  // 204 and friends have no body; `.json()` on an empty response throws.
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/** Exposed so `AuthProvider` can restore a session on cold load. */
export { refreshSession };
