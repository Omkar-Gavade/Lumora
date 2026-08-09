import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeLLMProvider } from '../../src/providers/llm/fake.provider.js';
import { GeminiProvider } from '../../src/providers/llm/gemini.provider.js';
import { OpenAiProvider } from '../../src/providers/llm/openai.provider.js';
import type { CompletionRequest, StreamChunk } from '../../src/providers/llm/llm-provider.interface.js';

const GROUNDED_PROMPT: CompletionRequest = {
  messages: [
    {
      role: 'system',
      content: 'RULES\n\nBEGIN SOURCES\n[1] a.pdf\nAlpha text.\n\n[2] b.pdf\nBeta text.\nEND SOURCES',
    },
    { role: 'user', content: 'What do the sources say?' },
  ],
};

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('FakeLLMProvider', () => {
  it('answers from the sources in the prompt, citing each', () => {
    /*
      Deterministic *and* grounded. A fake that returned a fixed string with no
      `[n]` in it would make citation mapping, validation, and snapshotting all
      untestable — which is most of what this milestone does.
    */
    const provider = new FakeLLMProvider();

    return provider.complete(GROUNDED_PROMPT).then((response) => {
      expect(response.content).toContain('[1]');
      expect(response.content).toContain('[2]');
      expect(response.finishReason).toBe('stop');
    });
  });

  it('is deterministic', async () => {
    const provider = new FakeLLMProvider();

    const first = await provider.complete(GROUNDED_PROMPT);
    const second = await provider.complete(GROUNDED_PROMPT);

    expect(second.content).toBe(first.content);
  });

  it('abstains when the prompt carries no sources', async () => {
    // The retrieval floor normally prevents this; answering anyway would let a
    // missing-source bug look like a working model.
    const provider = new FakeLLMProvider();

    const response = await provider.complete({
      messages: [{ role: 'user', content: 'anything' }],
    });

    expect(response.content).toContain('do not contain an answer');
  });

  it('records every call, for assertions about the prompt', async () => {
    const provider = new FakeLLMProvider();
    await provider.complete(GROUNDED_PROMPT);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages[0]?.role).toBe('system');
  });

  it('returns scripted content when told to', async () => {
    const provider = new FakeLLMProvider();
    provider.scriptNext('A scripted answer [1].');

    expect((await provider.complete(GROUNDED_PROMPT)).content).toBe('A scripted answer [1].');
  });

  it('throws a scripted error', async () => {
    const provider = new FakeLLMProvider();
    provider.scriptNext(new Error('provider exploded'));

    await expect(provider.complete(GROUNDED_PROMPT)).rejects.toThrow('provider exploded');
  });

  it('reports a forced finish reason', async () => {
    const provider = new FakeLLMProvider();
    provider.finishNextWith('length');

    // `length` means the answer was cut off, and the UI has to say so rather
    // than presenting a truncated paragraph as complete.
    expect((await provider.complete(GROUNDED_PROMPT)).finishReason).toBe('length');
  });

  it('streams tokens that reassemble into exactly the completed text', async () => {
    /*
      The property that keeps a streaming bug from hiding behind a passing
      non-streaming test: the accumulated stream must equal what `complete`
      returns for the same prompt.
    */
    const provider = new FakeLLMProvider();
    const expected = (await provider.complete(GROUNDED_PROMPT)).content;

    const chunks = await collect(provider.stream(GROUNDED_PROMPT, new AbortController().signal));
    const streamed = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'token' }> => chunk.type === 'token')
      .map((chunk) => chunk.text)
      .join('');

    expect(streamed).toBe(expected);
  });

  it('ends a stream with a done chunk carrying usage', async () => {
    const provider = new FakeLLMProvider();
    const chunks = await collect(provider.stream(GROUNDED_PROMPT, new AbortController().signal));

    const last = chunks.at(-1);
    expect(last?.type).toBe('done');
    if (last?.type === 'done') {
      expect(last.usage.completionTokens).toBeGreaterThan(0);
    }
  });

  it('stops streaming when the signal aborts', async () => {
    // The behaviour the stop button depends on (§7 step 11).
    const provider = new FakeLLMProvider();
    const controller = new AbortController();
    const chunks: StreamChunk[] = [];

    for await (const chunk of provider.stream(GROUNDED_PROMPT, controller.signal)) {
      chunks.push(chunk);
      if (chunks.length === 3) controller.abort();
    }

    const last = chunks.at(-1);
    expect(last?.type).toBe('done');
    if (last?.type === 'done') expect(last.finishReason).toBe('aborted');
    expect(chunks.length).toBeLessThan(30);
  });

  it('counts tokens with the same estimate as the rest of the codebase', () => {
    // A fake whose counts disagreed would make budget tests assert the fake's
    // arithmetic rather than the builder's.
    expect(new FakeLLMProvider().countTokens('12345678')).toBe(2);
  });
});

/**
 * The vendor adapters, against a stubbed transport.
 *
 * **No live calls.** These need API keys and would make the suite cost money
 * and depend on a third party's uptime. What is verified is everything that is
 * ours: request shaping, the role and system-instruction differences between
 * the two APIs, SSE framing, and the mapping from HTTP status to `retryable`.
 */
describe('OpenAiProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubJson(body: unknown, status = 200): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(body), { status })),
      ),
    );
  }

  it('sends messages unchanged, with temperature 0 by default', async () => {
    let sent = '';
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        sent = typeof init.body === 'string' ? init.body : '';
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 2 },
            }),
          ),
        );
      }),
    );

    await new OpenAiProvider('gpt-x', 128_000, 'key').complete(GROUNDED_PROMPT);

    const body = JSON.parse(sent) as { temperature: number; messages: { role: string }[] };
    // Determinism is the requirement: the same sources and question must give
    // the same answer.
    expect(body.temperature).toBe(0);
    expect(body.messages[0]?.role).toBe('system');
  });

  it('maps finish reasons onto the common vocabulary', async () => {
    stubJson({
      choices: [{ message: { content: 'cut off' }, finish_reason: 'length' }],
      usage: {},
    });

    const response = await new OpenAiProvider('gpt-x', 128_000, 'key').complete(GROUNDED_PROMPT);

    expect(response.finishReason).toBe('length');
  });

  it('maps a 429 to a retryable ProviderError', async () => {
    stubJson({ error: 'slow down' }, 429);

    await expect(
      new OpenAiProvider('gpt-x', 128_000, 'key').complete(GROUNDED_PROMPT),
    ).rejects.toMatchObject({ name: 'ProviderError', retryable: true, status: 429 });
  });

  it('maps a 401 to a permanent ProviderError', async () => {
    stubJson({ error: 'bad key' }, 401);

    await expect(
      new OpenAiProvider('gpt-x', 128_000, 'key').complete(GROUNDED_PROMPT),
    ).rejects.toMatchObject({ retryable: false, status: 401 });
  });

  it('parses an SSE stream, including a frame split across reads', async () => {
    /*
      The one thing a hand-rolled `split('\\n\\n')` per chunk gets wrong: a
      frame boundary can fall inside a TCP read. The buffer is what makes a
      token split across two reads arrive intact rather than as two corrupt
      frames.
    */
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"del',
      'ta":{"content":"lo"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
                controller.close();
              },
            }),
          ),
        ),
      ),
    );

    const chunks = await collect(
      new OpenAiProvider('gpt-x', 128_000, 'key').stream(
        GROUNDED_PROMPT,
        new AbortController().signal,
      ),
    );

    const text = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'token' }> => chunk.type === 'token')
      .map((chunk) => chunk.text)
      .join('');

    expect(text).toBe('Hello');
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it('skips a malformed frame rather than failing the stream', async () => {
    // The stream is still producing; discarding one delta beats discarding the
    // answer.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {not json}\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
          ),
        ),
      ),
    );

    const chunks = await collect(
      new OpenAiProvider('gpt-x', 128_000, 'key').stream(
        GROUNDED_PROMPT,
        new AbortController().signal,
      ),
    );

    expect(chunks.some((chunk) => chunk.type === 'token' && chunk.text === 'ok')).toBe(true);
  });
});

describe('GeminiProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureBody(response: unknown): { read: () => string } {
    let sent = '';
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        sent = typeof init.body === 'string' ? init.body : '';
        return Promise.resolve(new Response(JSON.stringify(response)));
      }),
    );
    return { read: () => sent };
  }

  const OK = {
    candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
  };

  it('lifts the system message into systemInstruction', async () => {
    /*
      Gemini has no `system` role. Sending the grounding rules as a user turn —
      the obvious workaround — measurably degrades instruction following, and
      §4.3's rules are precisely the instructions that must not be degraded.
    */
    const captured = captureBody(OK);

    await new GeminiProvider('gemini-x', 1_000_000, 'key').complete(GROUNDED_PROMPT);

    const body = JSON.parse(captured.read()) as {
      systemInstruction?: { parts: { text: string }[] };
      contents: { role: string }[];
    };

    expect(body.systemInstruction?.parts[0]?.text).toContain('BEGIN SOURCES');
    expect(body.contents.every((turn) => turn.role !== 'system')).toBe(true);
  });

  it('renames the assistant role to `model`', async () => {
    // A conversation replayed with the wrong role reads to the API as the user
    // having said everything, which makes multi-turn history useless.
    const captured = captureBody(OK);

    await new GeminiProvider('gemini-x', 1_000_000, 'key').complete({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    });

    const body = JSON.parse(captured.read()) as { contents: { role: string }[] };
    expect(body.contents.map((turn) => turn.role)).toEqual(['user', 'model', 'user']);
  });

  it('joins a candidate split across parts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                { content: { parts: [{ text: 'one ' }, { text: 'two' }] }, finishReason: 'STOP' },
              ],
            }),
          ),
        ),
      ),
    );

    const response = await new GeminiProvider('gemini-x', 1_000_000, 'key').complete(
      GROUNDED_PROMPT,
    );

    expect(response.content).toBe('one two');
  });

  it('normalizes MAX_TOKENS to length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }],
            }),
          ),
        ),
      ),
    );

    const response = await new GeminiProvider('gemini-x', 1_000_000, 'key').complete(
      GROUNDED_PROMPT,
    );

    expect(response.finishReason).toBe('length');
  });

  it('sends the API key as a header, never in the URL', async () => {
    // A key in a URL is logged by every proxy between here and Google.
    let url = '';
    let headers: Record<string, string> = {};

    vi.stubGlobal(
      'fetch',
      vi.fn((requestUrl: string, init: RequestInit) => {
        url = requestUrl;
        headers = init.headers as Record<string, string>;
        return Promise.resolve(new Response(JSON.stringify(OK)));
      }),
    );

    await new GeminiProvider('gemini-x', 1_000_000, 'secret').complete(GROUNDED_PROMPT);

    expect(url).not.toContain('secret');
    expect(headers['x-goog-api-key']).toBe('secret');
  });

  it('maps a 503 to a retryable ProviderError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('busy', { status: 503 }))));

    await expect(
      new GeminiProvider('gemini-x', 1_000_000, 'key').complete(GROUNDED_PROMPT),
    ).rejects.toMatchObject({ retryable: true, status: 503 });
  });

  it('treats a transport failure as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNRESET'))));

    await expect(
      new GeminiProvider('gemini-x', 1_000_000, 'key').complete(GROUNDED_PROMPT),
    ).rejects.toMatchObject({ retryable: true });
  });
});
