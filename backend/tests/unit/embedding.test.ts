import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/lib/logger.js';
import {
  ProviderError,
  isRetryableStatus,
} from '../../src/providers/embedding/embedding-provider.interface.js';
import { FakeEmbeddingProvider } from '../../src/providers/embedding/fake-embedding.provider.js';
import { GeminiEmbeddingProvider } from '../../src/providers/embedding/gemini-embedding.provider.js';
import { OpenAiEmbeddingProvider } from '../../src/providers/embedding/openai-embedding.provider.js';
import { embedInBatches } from '../../src/services/documents/embedding.service.js';

/**
 * The request body a stubbed `fetch` was called with.
 *
 * `RequestInit['body']` is a union covering streams and typed arrays, and
 * blindly stringifying it can yield `[object Object]`. Every call these
 * adapters make sends a JSON string, so narrowing to that is both accurate and
 * what makes a wrong body visible instead of silently passing.
 */
function bodyOf(init: RequestInit): string {
  return typeof init.body === 'string' ? init.body : '';
}

/** Never sleeps: a real backoff would make retry tests take minutes. */
const noSleep = (): Promise<void> => Promise.resolve();
const log = logger.child({ test: 'embedding' });

describe('FakeEmbeddingProvider', () => {
  it('returns the same vector for the same text, every time', () => {
    /*
      Determinism is why the fake exists. A random fake would make idempotency
      untestable — every rerun would write different vectors, and "the retry
      wrote the same vectors" could not be asserted at all.
    */
    const provider = new FakeEmbeddingProvider();

    return Promise.all([provider.embed(['hello']), provider.embed(['hello'])]).then(
      ([first, second]) => {
        expect(second).toEqual(first);
      },
    );
  });

  it('returns different vectors for different texts', async () => {
    const provider = new FakeEmbeddingProvider();
    const [alpha, beta] = await provider.embed(['alpha', 'beta']);

    expect(alpha).not.toEqual(beta);
  });

  it('honours the configured dimensionality', async () => {
    const provider = new FakeEmbeddingProvider({ dimensions: 384 });
    const [vector] = await provider.embed(['text']);

    // The hash is extended by counter suffixes, so it works past 32 bytes
    // rather than silently capping.
    expect(vector).toHaveLength(384);
  });

  it('returns unit vectors', async () => {
    const provider = new FakeEmbeddingProvider({ dimensions: 16 });
    const [vector] = await provider.embed(['normalize me']);

    const magnitude = Math.sqrt((vector ?? []).reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 6);
  });

  it('distinguishes a query from a document', async () => {
    /*
      Mirrors the asymmetric models the interface exists for. A retrieval test
      that accidentally embeds a query with the document path fails loudly here
      rather than degrading recall silently in production.
    */
    const provider = new FakeEmbeddingProvider();
    const [asDocument] = await provider.embed(['what is the notice period']);
    const asQuery = await provider.embedQuery('what is the notice period');

    expect(asQuery).not.toEqual(asDocument);
  });

  it('returns one vector per input, in order', async () => {
    const provider = new FakeEmbeddingProvider();
    const vectors = await provider.embed(['a', 'b', 'c']);
    const [single] = await provider.embed(['b']);

    expect(vectors).toHaveLength(3);
    // Positional pairing is the contract; the caller maps results back by index.
    expect(vectors[1]).toEqual(single);
  });
});

describe('embedInBatches', () => {
  it('splits work into batches of the configured size', async () => {
    // One request per chunk turns a 500-chunk PDF into 500 round trips against
    // a rate-limited endpoint.
    const provider = new FakeEmbeddingProvider();
    const tasks = Array.from({ length: 250 }, (_, index) => ({
      ref: index,
      text: `chunk ${String(index)}`,
    }));

    await embedInBatches(tasks, provider, log, { batchSize: 96, sleep: noSleep });

    expect(provider.calls).toHaveLength(3);
    expect(provider.calls.map((call) => call.texts.length)).toEqual([96, 96, 58]);
  });

  it('returns one result per task, paired to its ref', async () => {
    const provider = new FakeEmbeddingProvider();
    const tasks = [
      { ref: 'first', text: 'alpha' },
      { ref: 'second', text: 'beta' },
    ];

    const results = await embedInBatches(tasks, provider, log, { sleep: noSleep });

    expect(results.map((result) => result.ref)).toEqual(['first', 'second']);
    const [alpha] = await provider.embed(['alpha']);
    expect(results[0]?.embedding).toEqual(alpha);
  });

  it('skips empty and whitespace-only texts', async () => {
    /*
      §2.4 asks for this, and it is not merely wasteful: several providers
      reject an empty string with a non-retryable 400, so one blank chunk would
      dead-letter a document that is otherwise perfectly indexable.
    */
    const provider = new FakeEmbeddingProvider();
    const tasks = [
      { ref: 1, text: 'real content' },
      { ref: 2, text: '   \n  ' },
      { ref: 3, text: '' },
      { ref: 4, text: 'more content' },
    ];

    const results = await embedInBatches(tasks, provider, log, { sleep: noSleep });

    expect(results.map((result) => result.ref)).toEqual([1, 4]);
    expect(provider.calls[0]?.texts).toEqual(['real content', 'more content']);
  });

  it('reports progress after every batch, not once at the end', async () => {
    /*
      This is what makes recovery *partial*. A worker killed after batch 4 of 6
      leaves four batches durably recorded; holding everything until the end
      would discard work already paid for.
    */
    const provider = new FakeEmbeddingProvider();
    const tasks = Array.from({ length: 5 }, (_, index) => ({ ref: index, text: `t${String(index)}` }));
    const batches: number[][] = [];

    await embedInBatches(tasks, provider, log, {
      batchSize: 2,
      sleep: noSleep,
      onBatch: (results) => {
        batches.push(results.map((result) => result.ref));
        return Promise.resolve();
      },
    });

    expect(batches).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('retries a retryable failure and succeeds', async () => {
    // A single 429 must not fail a document that is 80% embedded and hand the
    // whole remainder back to the queue.
    const provider = new FakeEmbeddingProvider();
    provider.failNext(new ProviderError('fake', 'rate limited', true, 429));

    const results = await embedInBatches([{ ref: 1, text: 'text' }], provider, log, {
      maxRetries: 3,
      sleep: noSleep,
    });

    expect(results).toHaveLength(1);
    expect(provider.calls).toHaveLength(2);
  });

  it('gives up after the retry budget', async () => {
    const provider = new FakeEmbeddingProvider();
    provider.failNext(new ProviderError('fake', 'still rate limited', true, 429), 10);

    await expect(
      embedInBatches([{ ref: 1, text: 'text' }], provider, log, { maxRetries: 2, sleep: noSleep }),
    ).rejects.toThrow('still rate limited');

    // One initial attempt plus two retries.
    expect(provider.calls).toHaveLength(3);
  });

  it('does not retry a permanent failure', async () => {
    /*
      A 401 fails identically on every attempt. Spending three backoffs to
      confirm that keeps a document in `embedding` for minutes before showing
      the user an error that was knowable immediately.
    */
    const provider = new FakeEmbeddingProvider();
    provider.failNext(new ProviderError('fake', 'invalid api key', false, 401), 5);

    await expect(
      embedInBatches([{ ref: 1, text: 'text' }], provider, log, { maxRetries: 3, sleep: noSleep }),
    ).rejects.toThrow('invalid api key');

    expect(provider.calls).toHaveLength(1);
  });

  it('does not report a batch that failed', async () => {
    // `onBatch` writes progress. Calling it for a batch with no vectors would
    // mark chunks embedded whose vectors never existed.
    const provider = new FakeEmbeddingProvider();
    provider.failNext(new ProviderError('fake', 'permanent', false), 1);
    const reported: unknown[] = [];

    await expect(
      embedInBatches([{ ref: 1, text: 'text' }], provider, log, {
        sleep: noSleep,
        onBatch: (results) => {
          reported.push(results);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow();

    expect(reported).toEqual([]);
  });

  it('rejects a vector whose dimensionality does not match the provider', async () => {
    /*
      §2.4: embedding spaces are not comparable across models. A dimension
      mismatch means the model changed under an existing index, and the symptom
      is confident nonsense rather than an error — so it is caught at the one
      moment it is still cheap.
    */
    const provider = new FakeEmbeddingProvider({ dimensions: 8 });
    vi.spyOn(provider, 'embed').mockResolvedValue([[1, 2, 3]]);

    await expect(
      embedInBatches([{ ref: 1, text: 'text' }], provider, log, { sleep: noSleep }),
    ).rejects.toThrow(/3 dimensions, expected 8/);
  });

  it('does not retry a dimension mismatch', async () => {
    // A configuration fact; no number of attempts changes it.
    const provider = new FakeEmbeddingProvider({ dimensions: 8 });
    const embed = vi.spyOn(provider, 'embed').mockResolvedValue([[1, 2, 3]]);

    await expect(
      embedInBatches([{ ref: 1, text: 'text' }], provider, log, {
        maxRetries: 3,
        sleep: noSleep,
      }),
    ).rejects.toThrow();

    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('handles an empty task list without calling the provider', async () => {
    const provider = new FakeEmbeddingProvider();

    expect(await embedInBatches([], provider, log, { sleep: noSleep })).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('isRetryableStatus', () => {
  it('treats rate limits, timeouts, and server errors as retryable', () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('treats client errors as permanent', () => {
    // Retrying a 401 or a malformed 400 reaches the same answer three times.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

/**
 * The vendor adapters, against a stubbed transport.
 *
 * **These do not call Gemini or OpenAI.** Live calls need API keys and would
 * make the suite cost money and depend on a third party's uptime. What is
 * verified here is everything that is ours: request shaping, the asymmetric
 * task type, response ordering, and — most importantly — the mapping from HTTP
 * status to the `retryable` flag the job queue acts on.
 */
describe('GeminiEmbeddingProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, body: string) => Response): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(url, bodyOf(init)))),
    );
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('sends the API key as a header, never in the URL', async () => {
    // A key in a query string is logged by every proxy between here and Google.
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        return Promise.resolve(jsonResponse({ embeddings: [{ values: [1, 2, 3, 4] }] }));
      }),
    );

    const provider = new GeminiEmbeddingProvider('text-embedding-004', 4, 'secret-key');
    await provider.embed(['text']);

    expect(capturedUrl).not.toContain('secret-key');
    expect(capturedHeaders['x-goog-api-key']).toBe('secret-key');
  });

  it('uses RETRIEVAL_DOCUMENT for documents and RETRIEVAL_QUERY for queries', async () => {
    /*
      The reason `embedQuery` exists as a separate method (§6). Gemini is
      trained asymmetrically; embedding a query with the document task silently
      costs recall.
    */
    const bodies: string[] = [];

    stubFetch((_url, body) => {
      bodies.push(body);
      return jsonResponse({
        embeddings: [{ values: [1, 2, 3, 4] }],
        embedding: { values: [1, 2, 3, 4] },
      });
    });

    const provider = new GeminiEmbeddingProvider('text-embedding-004', 4, 'key');
    await provider.embed(['a document']);
    await provider.embedQuery('a question');

    expect(bodies[0]).toContain('RETRIEVAL_DOCUMENT');
    expect(bodies[1]).toContain('RETRIEVAL_QUERY');
  });

  it('maps a 429 to a retryable ProviderError', async () => {
    stubFetch(() => jsonResponse({ error: 'quota exceeded' }, 429));

    const provider = new GeminiEmbeddingProvider('text-embedding-004', 4, 'key');

    await expect(provider.embed(['text'])).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
      status: 429,
    });
  });

  it('maps a 401 to a permanent ProviderError', async () => {
    stubFetch(() => jsonResponse({ error: 'invalid key' }, 401));

    const provider = new GeminiEmbeddingProvider('text-embedding-004', 4, 'key');

    await expect(provider.embed(['text'])).rejects.toMatchObject({
      retryable: false,
      status: 401,
    });
  });

  it('rejects a response with fewer embeddings than inputs', async () => {
    /*
      The caller pairs vectors to chunks positionally, so a short response would
      attach every vector from that index on to the wrong chunk — a corruption
      that looks like valid data and surfaces only as bad retrieval later.
    */
    stubFetch(() => jsonResponse({ embeddings: [{ values: [1, 2, 3, 4] }] }));

    const provider = new GeminiEmbeddingProvider('text-embedding-004', 4, 'key');

    await expect(provider.embed(['one', 'two'])).rejects.toThrow(/expected 2 embeddings/);
  });

  it('treats a transport failure as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNRESET'))));

    const provider = new GeminiEmbeddingProvider('text-embedding-004', 4, 'key');

    await expect(provider.embed(['text'])).rejects.toMatchObject({ retryable: true });
  });

  it('does not call the provider for an empty batch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const provider = new GeminiEmbeddingProvider('text-embedding-004', 4, 'key');

    expect(await provider.embed([])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('OpenAiEmbeddingProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (body: string, init: RequestInit) => Response): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => Promise.resolve(handler(bodyOf(init), init))),
    );
  }

  it('sends the requested dimensionality explicitly', async () => {
    /*
      The v3 models support Matryoshka truncation, so the same model can return
      256 or 3072 dimensions. Leaving it to the default means a change to
      `EMBEDDING_DIMENSIONS` silently disagrees with what is stored.
    */
    let body = '';
    stubFetch((sent) => {
      body = sent;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }));
    });

    const provider = new OpenAiEmbeddingProvider('text-embedding-3-small', 4, 'key');
    await provider.embed(['text']);

    expect(JSON.parse(body)).toMatchObject({ dimensions: 4, model: 'text-embedding-3-small' });
  });

  it('reorders results by the declared index', async () => {
    /*
      OpenAI documents that `data` may come back out of order. Trusting arrival
      order would label every chunk in the batch with a neighbour's embedding.
    */
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [9, 9, 9, 9] },
              { index: 0, embedding: [1, 1, 1, 1] },
            ],
          }),
        ),
    );

    const provider = new OpenAiEmbeddingProvider('text-embedding-3-small', 4, 'key');
    const vectors = await provider.embed(['first', 'second']);

    expect(vectors[0]).toEqual([1, 1, 1, 1]);
    expect(vectors[1]).toEqual([9, 9, 9, 9]);
  });

  it('embeds a query through the same path, because the model is symmetric', async () => {
    // A property of the model, not a shortcut — the interface keeps the methods
    // separate so each provider can answer this for itself.
    let body = '';
    stubFetch((sent) => {
      body = sent;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }));
    });

    const provider = new OpenAiEmbeddingProvider('text-embedding-3-small', 4, 'key');
    const vector = await provider.embedQuery('a question');

    expect(vector).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(body)).toMatchObject({ input: ['a question'] });
  });

  it('maps a 500 to a retryable ProviderError', async () => {
    stubFetch(() => new Response('upstream exploded', { status: 500 }));

    const provider = new OpenAiEmbeddingProvider('text-embedding-3-small', 4, 'key');

    await expect(provider.embed(['text'])).rejects.toMatchObject({
      retryable: true,
      status: 500,
    });
  });

  it('sends the key as a bearer token', async () => {
    let headers: Record<string, string> = {};
    stubFetch((_body, init) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }));
    });

    const provider = new OpenAiEmbeddingProvider('text-embedding-3-small', 4, 'key');
    await provider.embed(['text']);

    expect(headers.Authorization).toBe('Bearer key');
  });
});
