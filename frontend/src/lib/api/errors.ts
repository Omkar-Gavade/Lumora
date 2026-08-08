import { ERROR_CODES, type ApiErrorResponse, type ErrorCode } from '@lumora/shared';

/** One field's complaint, as the backend's `ValidationError` sends it. */
export interface ApiFieldError {
  path: string;
  message: string;
}

/**
 * Every API failure, normalized to one type.
 *
 * The alternative — each caller inspecting `response.ok`, then guessing at the
 * body shape — is how a network blip and a 422 end up handled by the same
 * `catch` block that shows "Something went wrong".
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly requestId: string | null,
    readonly fields: ApiFieldError[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * The request never reached the server, or the response was unreadable.
   *
   * Status `0` because there was no HTTP response to take a status from —
   * inventing a 500 would tell the caller the server answered when it did not,
   * and "offline" needs different copy from "the server is broken".
   */
  static network(): ApiError {
    return new ApiError(
      0,
      ERROR_CODES.SERVICE_UNAVAILABLE,
      'Could not reach the server. Check your connection and try again.',
      null,
    );
  }

  is(code: ErrorCode): boolean {
    return this.code === code;
  }
}

interface ErrorDetailsWithFields {
  fields?: ApiFieldError[];
}

/**
 * Parses the backend's uniform error envelope (docs/03-backend.md §4).
 *
 * Defensive throughout: a 502 from a proxy in front of the API returns HTML,
 * not this shape, and a parser that assumes the contract holds turns an
 * infrastructure failure into a `TypeError` in the UI.
 */
export async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new ApiError(
      response.status,
      ERROR_CODES.INTERNAL_ERROR,
      'Something went wrong. Please try again.',
      null,
    );
  }

  const envelope = body as Partial<ApiErrorResponse>;
  const error = envelope.error;

  if (!error || typeof error.code !== 'string') {
    return new ApiError(
      response.status,
      ERROR_CODES.INTERNAL_ERROR,
      'Something went wrong. Please try again.',
      null,
    );
  }

  const details = error.details as ErrorDetailsWithFields | null;

  return new ApiError(
    response.status,
    error.code,
    error.message,
    error.requestId,
    details?.fields ?? [],
  );
}
