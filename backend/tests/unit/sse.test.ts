import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { SseWriter } from '../../src/lib/sse.js';
import {
  abortRegistry,
  resetAbortRegistryForTests,
} from '../../src/services/chat/abort-registry.js';

/**
 * A minimal `Response` double.
 *
 * Hand-written rather than mocked wholesale because the properties under test
 * are the ones a mock would paper over: `write` returning `false`,
 * `writableLength` growing, and `drain`/`close` firing. A stub that always
 * returns `true` would make the backpressure tests assert nothing.
 */
class FakeResponse extends EventEmitter {
  readonly chunks: string[] = [];
  headers: Record<string, string> = {};
  statusCode = 0;
  ended = false;
  /** When true, `write` reports the kernel buffer as full. */
  congested = false;
  writableLength = 0;

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (this.congested) this.writableLength += chunk.length;
    return !this.congested;
  }

  flushHeaders(): void {
    /* no-op */
  }

  end(): void {
    this.ended = true;
  }

  asResponse(): Response {
    return this as unknown as Response;
  }
}

function writerFor(res: FakeResponse, bufferSize = 10): SseWriter {
  return new SseWriter(res.asResponse(), { heartbeatMs: 10_000, bufferSize });
}

describe('SseWriter', () => {
  it('sets the headers that make streaming actually stream', () => {
    const res = new FakeResponse();
    writerFor(res).open();

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.headers['Cache-Control']).toContain('no-cache');
    // The one whose absence silently destroys the feature behind nginx.
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    expect(res.headers.Connection).toBe('keep-alive');
  });

  it('flushes an opening comment so the client’s reader starts immediately', () => {
    // Without it the client's `fetch` resolves only when the first token
    // happens to be written, which on a slow retrieval is seconds later.
    const res = new FakeResponse();
    writerFor(res).open();

    expect(res.chunks[0]).toBe(': open\n\n');
  });

  it('writes a named event as one SSE frame', () => {
    const res = new FakeResponse();
    const writer = writerFor(res);
    writer.open();

    writer.emit('token', { text: 'Revenue ' });

    expect(res.chunks.at(-1)).toBe('event: token\ndata: {"text":"Revenue "}\n\n');
  });

  it('keeps the payload on one line', () => {
    /*
      SSE frames are newline-delimited, so a pretty-printed payload would be
      read as several `data:` lines and reassembled into something unparseable.
    */
    const res = new FakeResponse();
    const writer = writerFor(res);
    writer.open();

    writer.emit('sources', { sources: [{ index: 1, text: 'a\nb' }] });

    const frame = res.chunks.at(-1) ?? '';
    const dataLines = frame.split('\n').filter((line) => line.startsWith('data:'));
    expect(dataLines).toHaveLength(1);
  });

  it('sends a heartbeat comment, not an event', async () => {
    // §8's 15s comment keeps intermediaries from timing the connection out,
    // and a comment cannot be mistaken for a message by the client.
    const res = new FakeResponse();
    const writer = new SseWriter(res.asResponse(), { heartbeatMs: 5, bufferSize: 10 });
    writer.open();

    await new Promise((resolve) => setTimeout(resolve, 20));
    writer.close();

    expect(res.chunks.some((chunk) => chunk === ': ping\n\n')).toBe(true);
  });

  it('stops the heartbeat when closed', async () => {
    const res = new FakeResponse();
    const writer = new SseWriter(res.asResponse(), { heartbeatMs: 5, bufferSize: 10 });
    writer.open();
    writer.close();

    const after = res.chunks.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(res.chunks).toHaveLength(after);
  });

  it('is a no-op after close rather than a crash', () => {
    // Emitting after close happens on every error path that runs alongside a
    // client disconnect; throwing there would replace a handled failure with
    // an unhandled one.
    const res = new FakeResponse();
    const writer = writerFor(res);
    writer.open();
    writer.close();

    expect(() => writer.emit('token', { text: 'late' })).not.toThrow();
    expect(res.chunks.at(-1)).not.toContain('late');
  });

  it('closes idempotently', () => {
    const res = new FakeResponse();
    const writer = writerFor(res);
    writer.open();

    writer.close();
    writer.close();

    expect(writer.isClosed).toBe(true);
    expect(res.ended).toBe(true);
  });

  it('waits for drain when the socket is congested', async () => {
    /*
      The backpressure `STREAM_BUFFER_SIZE` configures. Without it, a model
      producing faster than a client consumes accumulates the difference in
      process memory — unbounded, on a long answer to a slow connection.
    */
    const res = new FakeResponse();
    res.congested = true;
    const writer = writerFor(res, 4);
    writer.open();

    let resolved = false;
    const pending = writer.emitWithBackpressure('token', { text: 'x' }).then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    // Still waiting: the socket has not drained.
    expect(resolved).toBe(false);

    res.emit('drain');
    await pending;

    expect(resolved).toBe(true);
  });

  it('does not wait when the queue is below the threshold', async () => {
    // An occasional slow write must not cost a round trip through the event
    // loop; only genuine congestion does.
    const res = new FakeResponse();
    res.congested = true;
    const writer = writerFor(res, 1_000_000);
    writer.open();

    await expect(writer.emitWithBackpressure('token', { text: 'x' })).resolves.toBeUndefined();
  });

  it('stops waiting when the client disappears mid-write', async () => {
    // A closed socket never drains; without this the stream hangs forever on a
    // client that vanished.
    const res = new FakeResponse();
    res.congested = true;
    const writer = writerFor(res, 1);
    writer.open();

    const pending = writer.emitWithBackpressure('token', { text: 'x' });
    res.emit('close');

    await expect(pending).resolves.toBeUndefined();
  });

  it('reports a client disconnect only before a normal close', () => {
    /*
      `close` fires on a normal end too. Treating that as a disconnect would
      abort a generation that had just finished successfully — and log an
      abandonment that never happened.
    */
    const res = new FakeResponse();
    const writer = writerFor(res);
    writer.open();

    const onDisconnect = vi.fn();
    writer.onClientDisconnect(onDisconnect);

    writer.close();
    res.emit('close');

    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('reports a genuine early disconnect', () => {
    const res = new FakeResponse();
    const writer = writerFor(res);
    writer.open();

    const onDisconnect = vi.fn();
    writer.onClientDisconnect(onDisconnect);

    res.emit('close');

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe('abortRegistry', () => {
  it('aborts a registered generation', () => {
    resetAbortRegistryForTests();
    const controller = new AbortController();
    abortRegistry.register('conversation-1', controller);

    expect(abortRegistry.abort('conversation-1')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('reports when nothing was running', () => {
    // The stop endpoint answers 204 either way — "stop" asks for a state, not
    // an event — but it logs which happened.
    resetAbortRegistryForTests();

    expect(abortRegistry.abort('nothing-here')).toBe(false);
  });

  it('supersedes an earlier generation on the same conversation', () => {
    /*
      A user who sends a second message has abandoned the first answer. Letting
      both run bills for two completions to display one.
    */
    resetAbortRegistryForTests();
    const first = new AbortController();
    const second = new AbortController();

    abortRegistry.register('conversation-1', first);
    abortRegistry.register('conversation-1', second);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('unregisters only its own controller', () => {
    /*
      The subtle one. A finishing stream must not delete the entry belonging to
      the generation that superseded it — doing so leaves the new one
      unstoppable, and the stop button silently does nothing.
    */
    resetAbortRegistryForTests();
    const first = new AbortController();
    const second = new AbortController();

    const unregisterFirst = abortRegistry.register('conversation-1', first);
    abortRegistry.register('conversation-1', second);

    unregisterFirst();

    expect(abortRegistry.has('conversation-1')).toBe(true);
    expect(abortRegistry.abort('conversation-1')).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it('leaves nothing registered once a stream unregisters', () => {
    resetAbortRegistryForTests();
    const controller = new AbortController();

    abortRegistry.register('conversation-1', controller)();

    expect(abortRegistry.has('conversation-1')).toBe(false);
    expect(abortRegistry.size).toBe(0);
  });

  it('keeps conversations independent', () => {
    resetAbortRegistryForTests();
    const first = new AbortController();
    const second = new AbortController();

    abortRegistry.register('conversation-1', first);
    abortRegistry.register('conversation-2', second);
    abortRegistry.abort('conversation-1');

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);

    resetAbortRegistryForTests();
  });
});
