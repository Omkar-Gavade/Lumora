import type { Response } from 'express';

/**
 * A Server-Sent Events writer (docs/03-backend.md §8).
 *
 * Four of the headers below are not cosmetic:
 *
 * - `text/event-stream` is what makes the browser treat the body as a stream
 *   rather than a document to buffer.
 * - `no-cache` stops an intermediary serving a stale generation to the next
 *   request that looks similar.
 * - **`X-Accel-Buffering: no`** is the one that silently destroys the feature
 *   when omitted: nginx buffers proxied responses by default, so every token
 *   arrives at once when the stream closes and streaming becomes an expensive
 *   way to do request/response.
 * - `Connection: keep-alive` keeps the socket open across the gap between
 *   tokens.
 *
 * Named events give the client a typed protocol rather than string sniffing.
 */
export type SseEvent =
  | 'status'
  | 'sources'
  | 'token'
  | 'citation'
  | 'title'
  | 'done'
  | 'error';

export interface SseWriterOptions {
  /** Comment heartbeat cadence. §8 specifies 15s. */
  heartbeatMs: number;
  /**
   * Bytes that may sit unflushed before the writer waits for `drain`.
   *
   * **Not in the documentation** — see `config/env.ts` for why it exists. A
   * writer that never checks `write()`'s return value queues every token in
   * process memory when the client reads slower than the model produces, which
   * on a long answer to a mobile client is unbounded growth.
   */
  bufferSize: number;
}

/**
 * Owns one SSE response.
 *
 * Deliberately a class with explicit `close()` rather than a set of helper
 * functions: a stream has a lifecycle — headers, heartbeat timer, terminal
 * event, socket — and every one of those leaks if some code path forgets a
 * step. One object that knows whether it is still open makes "emit after
 * close" a no-op instead of a crash inside an error handler.
 */
export class SseWriter {
  private closed = false;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly res: Response,
    private readonly options: SseWriterOptions,
  ) {}

  /** Writes the headers and starts the heartbeat. Safe to call once. */
  open(): void {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeats proxy buffering. Without it, streaming arrives in one chunk.
      'X-Accel-Buffering': 'no',
    });

    // An initial comment flushes the headers immediately, so the client's
    // `fetch` resolves and its reader starts before the first token — rather
    // than at whatever moment the first write happens to occur.
    this.res.write(': open\n\n');
    this.res.flushHeaders?.();

    this.heartbeat = setInterval(() => {
      // A comment, not an event: it keeps intermediaries from timing the
      // connection out without appearing in the client's event stream.
      if (!this.closed) this.res.write(': ping\n\n');
    }, this.options.heartbeatMs);

    // Never a reason to hold the process open during shutdown.
    this.heartbeat.unref();
  }

  /**
   * Emits one named event.
   *
   * Returns whether the socket accepted the write without buffering. `false`
   * means the kernel buffer is full and the caller should await `drain` before
   * producing more — which is what `writeBackpressured` does.
   */
  emit(event: SseEvent, data: unknown): boolean {
    if (this.closed) return true;

    /*
      `JSON.stringify` on one line, deliberately.

      SSE frames are newline-delimited, so a pretty-printed payload would be
      parsed as several `data:` lines and reassembled into something the client
      cannot parse. Every value the API emits is JSON-safe by construction.
    */
    return this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Emits, and waits for the socket to drain if it is congested.
   *
   * This is the backpressure the buffer size configures. A model producing
   * faster than a client consumes is the ordinary case on a slow connection,
   * and without this the difference accumulates in Node's write queue.
   */
  async emitWithBackpressure(event: SseEvent, data: unknown): Promise<void> {
    const accepted = this.emit(event, data);
    if (accepted || this.closed) return;

    // `writableLength` is what the socket has queued. Waiting only while it
    // exceeds the threshold means an occasional slow write costs nothing.
    if (this.res.writableLength < this.options.bufferSize) return;

    await new Promise<void>((resolve) => {
      const done = (): void => {
        this.res.off('drain', done);
        resolve();
      };

      this.res.once('drain', done);
      // A closed socket never drains; resolving on `close` stops the stream
      // hanging on a client that disappeared mid-write.
      this.res.once('close', done);
    });
  }

  /**
   * Runs `handler` when the client goes away.
   *
   * docs/03-backend.md §8 requires "a `close` listener on the request that
   * aborts the provider call so a user who navigates away stops incurring
   * generation cost immediately." Exposed here rather than left to the caller
   * so the listener is registered on the object that owns the socket, and
   * cannot be attached to a response that was already closed.
   */
  onClientDisconnect(handler: () => void): void {
    this.res.on('close', () => {
      // `close` also fires on a normal end. Only an early close — while the
      // stream still believes it is open — means the client left.
      if (!this.closed) handler();
    });
  }

  /** Stops the heartbeat and ends the response. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }

    this.res.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
