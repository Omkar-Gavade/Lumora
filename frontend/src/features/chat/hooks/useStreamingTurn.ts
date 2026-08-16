import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CitationDto, StreamPhase, TurnSourceDto } from '@lumora/shared';
import { queryKeys } from '@/app/config/query-keys';
import { env } from '@/app/config/env';
import { getAccessToken } from '@/lib/api/client';
import { openChatStream } from '../api/stream';

/**
 * Everything one in-flight turn shows.
 *
 * Held in component state rather than in the query cache: a stream produces
 * dozens of updates per second, and writing each to the cache would invalidate
 * and re-render every consumer of the thread on every token. The cache is
 * updated once, when the turn finishes.
 */
export interface StreamingTurn {
  /** The question, echoed optimistically before the server confirms it. */
  question: string;
  /** Tokens accumulated so far. */
  text: string;
  phase: StreamPhase | null;
  sources: TurnSourceDto[];
  citations: CitationDto[];
  /** Set when the stream ends abnormally. */
  error: string | null;
  /** `stopped` once the user or a disconnect ended it early. */
  finishReason: string | null;
}

const EMPTY: StreamingTurn = {
  question: '',
  text: '',
  phase: null,
  sources: [],
  citations: [],
  error: null,
  finishReason: null,
};

/**
 * Drives one streaming turn.
 *
 * The state machine is small on purpose: `turn === null` means idle, a non-null
 * `turn` with `finishReason === null` means generating, and anything else is a
 * finished turn still on screen. Components read those three rather than a set
 * of independent booleans that can contradict each other.
 */
export function useStreamingTurn() {
  const client = useQueryClient();

  const [turn, setTurn] = useState<StreamingTurn | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  /**
   * The conversation the live stream belongs to.
   *
   * Read when deciding whether to render the in-flight turn: switching threads
   * mid-stream must not paint the previous thread's tokens into the new one.
   */
  const [streamingFor, setStreamingFor] = useState<string | null>(null);

  const isStreaming = turn !== null && turn.finishReason === null && turn.error === null;

  const start = useCallback(
    async (options: {
      conversationId: string;
      content: string;
      /** Regenerating: the assistant message being replaced. */
      regenerateFrom?: string;
    }) => {
      // A second send supersedes the first, matching the server's registry.
      controllerRef.current?.abort();

      const controller = new AbortController();
      controllerRef.current = controller;
      setStreamingFor(options.conversationId);

      setTurn({ ...EMPTY, question: options.content });

      const path =
        options.regenerateFrom === undefined
          ? `/conversations/${options.conversationId}/messages`
          : `/conversations/${options.conversationId}/messages/${options.regenerateFrom}/regenerate`;

      try {
        for await (const event of openChatStream(
          path,
          options.regenerateFrom === undefined ? { content: options.content } : {},
          controller.signal,
        )) {
          switch (event.event) {
            case 'status':
              setTurn((current) => (current === null ? current : { ...current, phase: event.data.phase }));
              break;

            case 'sources':
              setTurn((current) =>
                current === null ? current : { ...current, sources: event.data.sources },
              );
              break;

            case 'token':
              // Appended, never replaced: the accumulated text *is* the answer,
              // and rebuilding it from a list of tokens on every render would
              // be O(n²) over the length of the answer.
              setTurn((current) =>
                current === null ? current : { ...current, text: current.text + event.data.text },
              );
              break;

            case 'citation':
              setTurn((current) =>
                current === null
                  ? current
                  : { ...current, citations: [...current.citations, event.data] },
              );
              break;

            case 'title':
              // The sidebar row renames itself as soon as titling lands.
              void client.invalidateQueries({ queryKey: queryKeys.conversations.list() });
              break;

            case 'done':
              setTurn((current) =>
                current === null
                  ? current
                  : { ...current, finishReason: event.data.finishReason },
              );
              /*
                The thread is refetched once, here — not per token.

                The finalized message is on the `done` event, but the *user*
                message, its sequence, and any prior turn's citations are not,
                and reconstructing the thread from stream events would be a
                second source of truth that drifts from the database.
              */
              void client.invalidateQueries({
                queryKey: queryKeys.conversations.detail(options.conversationId),
              });
              void client.invalidateQueries({ queryKey: queryKeys.conversations.list() });
              break;

            case 'error':
              setTurn((current) =>
                current === null ? current : { ...current, error: event.data.message },
              );
              void client.invalidateQueries({
                queryKey: queryKeys.conversations.detail(options.conversationId),
              });
              break;
          }
        }
      } catch {
        /*
          An aborted fetch throws, and that is the stop button working rather
          than a failure. Anything else is a real transport error and gets an
          inline notice — with the partial text kept, per docs/00-product.md
          §8.3: "partial text is kept, an inline notice appears, Retry
          re-requests from the last user message."
        */
        if (controller.signal.aborted) {
          setTurn((current) => (current === null ? current : { ...current, finishReason: 'aborted' }));
        } else {
          setTurn((current) =>
            current === null
              ? current
              : { ...current, error: 'The connection dropped before the answer finished.' },
          );
        }

        void client.invalidateQueries({
          queryKey: queryKeys.conversations.detail(options.conversationId),
        });
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [client],
  );

  /**
   * Stops generation.
   *
   * Aborts the fetch **and** calls the stop endpoint, because §7 keeps both
   * paths for a reason: "the abort signal is unreliable behind some proxies
   * and the explicit endpoint is a guaranteed fallback. Both are idempotent."
   * Doing only the first leaves the server generating behind a proxy that
   * swallowed the reset; doing only the second is a round trip the local abort
   * makes instant.
   */
  const stop = useCallback((conversationId: string) => {
    controllerRef.current?.abort();

    const token = getAccessToken();

    void fetch(`${env.VITE_API_URL}/api/v1/conversations/${conversationId}/stop`, {
      method: 'POST',
      credentials: 'include',
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      // Failure is ignored: the local abort has already stopped the client
      // reading, and the endpoint is the belt to that braces.
    }).catch(() => undefined);
  }, []);

  /** Clears a finished turn — used when switching threads. */
  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStreamingFor(null);
    setTurn(null);
  }, []);

  return {
    turn,
    isStreaming,
    /** The thread the live turn belongs to, so a switch can hide it. */
    streamingFor,
    start,
    stop,
    reset,
  };
}
