import type { ChatStreamEvent } from '@lumora/shared';
import { env } from '@/app/config/env';
import { getAccessToken } from '@/lib/api/client';
import { ApiError, toApiError } from '@/lib/api/errors';

const API_PREFIX = '/api/v1';

/**
 * Opens a chat stream and yields typed events.
 *
 * **`fetch` rather than `EventSource`, and that is forced rather than
 * preferred.** `EventSource` only issues GET requests and cannot set an
 * `Authorization` header; the documented endpoint is a POST with a JSON body
 * (docs/04-data-and-api.md §2.4). Using `EventSource` would mean either moving
 * the question into a query string — where every proxy logs it — or splitting
 * the turn into a create-then-watch pair, which §2.4 rejects by name.
 *
 * The frame buffer across reads is the part that has to be right: a frame
 * boundary can fall inside a network chunk, so a `split('\n\n')` per chunk
 * corrupts exactly the token that straddles it.
 */
export async function* openChatStream(
  path: string,
  body: unknown,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const token = getAccessToken();

  const response = await fetch(`${env.VITE_API_URL}${API_PREFIX}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });

  /*
    A non-200 is a normal HTTP failure — the server rejects before opening the
    stream precisely so this stays possible (validation, ownership, rate
    limits). Once the stream is open, failures arrive as `error` events.
  */
  if (!response.ok) {
    throw await toApiError(response);
  }

  if (response.body === null) {
    throw ApiError.network();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');

        const parsed = parseFrame(frame);
        if (parsed !== null) yield parsed;
      }
    }
  } finally {
    // Releases the connection. Without it, an abandoned stream leaks a socket
    // per cancelled generation.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Parses one SSE frame.
 *
 * Returns `null` for anything that is not a complete named event — heartbeat
 * comments (`: ping`) and the opening flush both arrive as frames and are not
 * errors. A malformed `data:` payload is skipped rather than thrown: the
 * stream is still producing, and discarding one token beats discarding the
 * answer.
 */
function parseFrame(frame: string): ChatStreamEvent | null {
  if (frame.startsWith(':')) return null;

  const event = /^event: (.+)$/m.exec(frame)?.[1];
  const data = /^data: (.+)$/m.exec(frame)?.[1];
  if (event === undefined || data === undefined) return null;

  try {
    // `as unknown` first: `JSON.parse` returns `any`, and letting that flow
    // straight into a typed union would silence every check the union exists
    // to provide.
    return { event, data: JSON.parse(data) as unknown } as ChatStreamEvent;
  } catch {
    return null;
  }
}
