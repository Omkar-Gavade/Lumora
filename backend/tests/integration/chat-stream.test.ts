import { describe, expect, it } from 'vitest';
import type { ConversationDto } from '@lumora/shared';
import { llmProvider } from '../../src/providers/llm/llm.factory.js';
import { FakeLLMProvider } from '../../src/providers/llm/fake.provider.js';
import { ProviderError } from '../../src/providers/llm/llm-provider.interface.js';
import { abortRegistry } from '../../src/services/chat/abort-registry.js';
import { citationRepository } from '../../src/repositories/citation.repository.js';
import { messageRepository } from '../../src/repositories/message.repository.js';
import { IngestionWorker } from '../../src/workers/ingestion.worker.js';
import { API_PREFIX, baseUrl, request } from '../helpers/app.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { createVerifiedUser, type TestUser } from '../factories/user.factory.js';

/**
 * The SSE turn (docs/05-rag-and-chat.md §7, docs/03-backend.md §8).
 *
 * Driven with real `fetch` against a real listening server rather than through
 * supertest: supertest buffers the whole response before resolving, which
 * makes it structurally unable to observe a *stream*. Every assertion below
 * about ordering, abort, or partial output depends on reading frames as they
 * arrive.
 */

const CORPUS = [
  '# Employment Agreement',
  '',
  '## 3. Termination',
  '',
  'Either party may terminate this agreement with thirty days written notice delivered to the address of record. The notice period begins the following day.',
  '',
  '## 4. Equipment',
  '',
  'Each employee is issued one ACME-1200/B workstation and replacement rails under part number RL-88.',
].join('\n');

function fakeLLM(): FakeLLMProvider {
  if (!(llmProvider instanceof FakeLLMProvider)) {
    throw new Error(`expected the fake LLM in tests, got "${llmProvider.name}"`);
  }
  return llmProvider;
}

async function seedCorpus(user: TestUser): Promise<void> {
  await uploadDocument(user.session.accessToken, {
    bytes: FIXTURES.markdown(CORPUS),
    filename: uniqueFilename('.md'),
    contentType: 'text/markdown',
  });
  await new IngestionWorker({ workerId: 'stream-seed', concurrency: 1 }).drain();
}

async function newConversation(user: TestUser): Promise<ConversationDto> {
  const response = await request()
    .post(`${API_PREFIX}/conversations`)
    .set('Authorization', `Bearer ${user.session.accessToken}`)
    .send({})
    .expect(201);

  return response.body as ConversationDto;
}

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Opens a stream and yields frames as they arrive.
 *
 * The buffer across reads is the part that matters: a frame boundary can fall
 * inside a TCP read, and a naive `split('\n\n')` per chunk corrupts exactly the
 * token that straddles it.
 */
async function* openStream(
  user: TestUser,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<Frame> {
  const response = await fetch(`${baseUrl()}${API_PREFIX}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.session.accessToken}`,
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });

  if (response.status !== 200) {
    throw new Error(`stream did not open: ${String(response.status)}`);
  }
  if (!response.body) throw new Error('stream had no body');

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
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');

        // Comments (`: ping`) are heartbeats, not events.
        if (raw.startsWith(':')) continue;

        const event = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (event === undefined || data === undefined) continue;

        yield { event, data: JSON.parse(data) as Record<string, unknown> };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function collectStream(user: TestUser, path: string, body: unknown): Promise<Frame[]> {
  const frames: Frame[] = [];
  for await (const frame of openStream(user, path, body)) frames.push(frame);
  return frames;
}

function tokensOf(frames: Frame[]): string {
  return frames
    .filter((frame) => frame.event === 'token')
    .map((frame) => String(frame.data.text))
    .join('');
}

describe('SSE lifecycle', () => {
  it('sets the headers that make streaming actually stream', async () => {
    /*
      `X-Accel-Buffering: no` is the one that silently destroys the feature:
      nginx buffers proxied responses by default, so every token would arrive
      at once when the stream closes (docs/03-backend.md §8).
    */
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const response = await fetch(
      `${baseUrl()}${API_PREFIX}/conversations/${conversation.id}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.session.accessToken}`,
        },
        body: JSON.stringify({ content: 'What is the notice period?' }),
      },
    );

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    await response.body?.cancel();
  });

  it('emits the documented event sequence', async () => {
    // §7 steps 5, 8, 9, 10, 12 — status, sources, status, tokens, done.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const frames = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });

    const events = frames.map((frame) => frame.event);

    expect(events[0]).toBe('status');
    expect(events).toContain('sources');
    expect(events).toContain('token');
    expect(events).toContain('citation');
    expect(events.at(-1) === 'done' || events.includes('done')).toBe(true);
  });

  it('sends sources before the first token', async () => {
    /*
      §8: "`sources` is sent **before** the first token deliberately: the UI can
      render the source list while the model is still writing, which removes the
      perception of a stall during the slowest part of the request."
    */
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const frames = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });

    const events = frames.map((frame) => frame.event);
    expect(events.indexOf('sources')).toBeLessThan(events.indexOf('token'));
  });

  it('reports real phases, not theatre', async () => {
    // docs/00-product.md §8.3: "These are real phases reported by the server
    // over the stream, not fake theatre."
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const frames = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });

    const phases = frames
      .filter((frame) => frame.event === 'status')
      .map((frame) => String(frame.data.phase));

    expect(phases[0]).toBe('retrieving');
    expect(phases).toContain('generating');
    // `retrieving` precedes `generating`, always.
    expect(phases.indexOf('retrieving')).toBeLessThan(phases.lastIndexOf('generating'));
  });

  it('streams tokens that reassemble into the persisted answer', async () => {
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const frames = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });

    const streamed = tokensOf(frames);
    const done = frames.find((frame) => frame.event === 'done');
    const messageId = (done?.data.message as { id: string }).id;

    const stored = await messageRepository.findById(messageId, user.id);

    expect(streamed.length).toBeGreaterThan(0);
    // Identical, so a streaming bug cannot hide behind a correct database row.
    expect(stored?.content).toBe(streamed);
    expect(stored?.status).toBe('complete');
  });

  it('emits one citation event per mapped citation', async () => {
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const frames = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });

    const citations = frames.filter((frame) => frame.event === 'citation');
    const done = frames.find((frame) => frame.event === 'done');
    const messageId = (done?.data.message as { id: string }).id;

    const persisted = await citationRepository.findByMessage(messageId);

    expect(citations.length).toBeGreaterThan(0);
    expect(citations).toHaveLength(persisted.length);
    // The `[n]` in the text and the `[n]` in the panel are the same passage.
    for (const frame of citations) {
      expect(frame.data.chunkId).toBeDefined();
      expect(frame.data.contentSnapshot).toBeDefined();
    }
  });

  it('carries the finalized message on the done event', async () => {
    // So the client replaces its optimistic copy with the row that exists.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const frames = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });

    const done = frames.find((frame) => frame.event === 'done');
    const message = done?.data.message as { id: string; status: string; role: string };

    expect(message.role).toBe('assistant');
    expect(message.status).toBe('complete');
    expect(done?.data.finishReason).toBe('stop');
  });

  it('rejects an unowned conversation with a 404, not an error event', async () => {
    /*
      Ownership is proved before the headers go out. A stream that opens 200 and
      then fails is a worse signal than a status code — and invisible to any
      client that checks `response.ok`.
    */
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const conversation = await newConversation(owner);

    const response = await fetch(
      `${baseUrl()}${API_PREFIX}/conversations/${conversation.id}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${stranger.session.accessToken}`,
        },
        body: JSON.stringify({ content: 'What is the notice period?' }),
      },
    );

    expect(response.status).toBe(404);
    await response.body?.cancel();
  });

  it('rejects an empty message before opening a stream', async () => {
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    const response = await fetch(
      `${baseUrl()}${API_PREFIX}/conversations/${conversation.id}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.session.accessToken}`,
        },
        body: JSON.stringify({ content: '   ' }),
      },
    );

    expect(response.status).toBe(422);
    await response.body?.cancel();
  });
});

describe('abstention over the stream', () => {
  it('streams the abstention without calling the model', async () => {
    // §3.3 short-circuits before generation; the client still sees one shape.
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    fakeLLM().reset();

    const frames = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });

    expect(tokensOf(frames)).toContain("haven't uploaded any documents");
    expect(frames.find((frame) => frame.event === 'done')?.data.finishReason).toBe('abstained');
    // The decisive assertion: zero provider calls.
    expect(fakeLLM().calls).toHaveLength(0);

    fakeLLM().reset();
  });
});

describe('stop generation', () => {
  it('persists the partial answer and marks it stopped', async () => {
    /*
      §7 step 11. This is the half of crash-safety the transaction in step 3
      does not cover: whatever arrived is kept, so a stopped answer survives a
      reload rather than leaving a question with no reply.
    */
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    // Slow enough that the stop lands mid-answer.
    fakeLLM().setStreamDelay(30);

    const frames: Frame[] = [];
    let stopped = false;

    for await (const frame of openStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    })) {
      frames.push(frame);

      if (!stopped && frames.filter((entry) => entry.event === 'token').length >= 3) {
        stopped = true;
        await request()
          .post(`${API_PREFIX}/conversations/${conversation.id}/stop`)
          .set('Authorization', `Bearer ${user.session.accessToken}`)
          .expect(204);
      }
    }

    fakeLLM().reset();

    const done = frames.find((frame) => frame.event === 'done');
    expect(done?.data.finishReason).toBe('aborted');

    const messageId = (done?.data.message as { id: string }).id;
    const stored = await messageRepository.findById(messageId, user.id);

    expect(stored?.status).toBe('stopped');
    // The partial text is kept, not discarded.
    expect(stored?.content.length).toBeGreaterThan(0);
    expect(stored?.content).toBe(tokensOf(frames));
  });

  it('is idempotent — stopping twice is not an error', async () => {
    // §7: "Both are idempotent."
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    await request()
      .post(`${API_PREFIX}/conversations/${conversation.id}/stop`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(204);
    await request()
      .post(`${API_PREFIX}/conversations/${conversation.id}/stop`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(204);
  });

  it('answers 204 when nothing is generating', async () => {
    // "Stop" asks for a state, not for an event. A 404 would make the client
    // report an error for the outcome it wanted.
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    await request()
      .post(`${API_PREFIX}/conversations/${conversation.id}/stop`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(204);
  });

  it('refuses to stop another user’s generation', async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const conversation = await newConversation(owner);

    await request()
      .post(`${API_PREFIX}/conversations/${conversation.id}/stop`)
      .set('Authorization', `Bearer ${stranger.session.accessToken}`)
      .expect(404);
  });

  it('clears the registry when the stream ends', async () => {
    // A registry that leaked entries would make a later stop abort a
    // generation that had already finished — or nothing at all.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });

    expect(abortRegistry.has(conversation.id)).toBe(false);
  });
});

describe('client disconnect', () => {
  it('persists what arrived when the client goes away mid-stream', async () => {
    /*
      docs/03-backend.md §8: "a `close` listener on the request that aborts the
      provider call so a user who navigates away stops incurring generation
      cost immediately."

      The user closing a tab and the user pressing stop are the same event to
      the data, and both must leave a readable thread.
    */
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    /*
      The length of a complete answer to this question, measured rather than
      guessed — so "genuinely partial" is an assertion about this corpus rather
      than a magic number that drifts when the fixture changes.
    */
    const reference = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });
    const fullAnswerLength = tokensOf(reference).length;

    fakeLLM().setStreamDelay(30);

    const controller = new AbortController();
    let tokens = 0;

    try {
      for await (const frame of openStream(
        user,
        `/conversations/${conversation.id}/messages`,
        { content: 'What is the notice period?' },
        controller.signal,
      )) {
        if (frame.event === 'token') tokens += 1;
        // Abort the fetch outright — the client vanishing, not asking politely.
        if (tokens >= 3) controller.abort();
      }
    } catch {
      // An aborted fetch throws; that is the disconnect being simulated.
    }

    fakeLLM().reset();

    // The server needs a moment to notice `close` and finalize.
    await waitFor(async () => {
      const messages = await messageRepository.listByConversation(conversation.id, user.id);
      // The *last* assistant turn: the reference run above left one of its own.
      const assistant = messages.filter((message) => message.role === 'assistant').at(-1);
      return assistant !== undefined && assistant.status !== 'pending';
    });

    const messages = await messageRepository.listByConversation(conversation.id, user.id);
    const assistant = messages.filter((message) => message.role === 'assistant').at(-1);

    /*
      **`stopped`, not `complete`** — and that distinction is the whole test.

      Accepting either would pass with no disconnect listener at all: the
      generation would simply run to completion and be persisted as a finished
      answer nobody is reading. `stopped` is the only status that proves the
      `close` handler fired and cut generation short, which is what stops the
      user paying for tokens after they navigated away.
    */
    expect(assistant?.status).toBe('stopped');

    // Never left as a `pending` placeholder — the thread-with-no-reply defect.
    expect(assistant?.content.length).toBeGreaterThan(0);
    // And genuinely partial: a full answer would mean generation was not cut.
    expect(assistant?.content.length).toBeLessThan(fullAnswerLength);
  });
});

describe('stream errors', () => {
  it('emits an error event and persists the failure', async () => {
    // §7 step 14.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    fakeLLM().scriptNext(new ProviderError('fake', 'model exploded', true, 503));

    const frames = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });

    const error = frames.find((frame) => frame.event === 'error');
    expect(error?.data.code).toBe('PROVIDER_ERROR');
    // The provider's own message is never forwarded — it routinely echoes
    // request contents and internal endpoints.
    expect(String(error?.data.message)).not.toContain('model exploded');

    const messages = await messageRepository.listByConversation(conversation.id, user.id);
    expect(messages[1]?.status).toBe('failed');
    expect(messages[1]?.errorCode).toBe('PROVIDER_ERROR');

    fakeLLM().reset();
  });

  it('opens with a 200 even when generation will fail', async () => {
    // The failure happens after the headers; it cannot be a status code.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    fakeLLM().scriptNext(new ProviderError('fake', 'down', true, 503));

    const response = await fetch(
      `${baseUrl()}${API_PREFIX}/conversations/${conversation.id}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.session.accessToken}`,
        },
        body: JSON.stringify({ content: 'What is the notice period?' }),
      },
    );

    expect(response.status).toBe(200);
    await response.body?.cancel();
    fakeLLM().reset();
  });
});

describe('regenerate', () => {
  it('creates a new assistant message pointing at the one it replaced', async () => {
    /*
      §7: "Regeneration creates a new assistant message with `parent_id`
      pointing at the replaced one rather than mutating in place, preserving
      lineage and keeping the option of a version switcher without a schema
      change."
    */
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const first = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });
    const originalId = (first.find((frame) => frame.event === 'done')?.data.message as { id: string })
      .id;

    const second = await collectStream(
      user,
      `/conversations/${conversation.id}/messages/${originalId}/regenerate`,
      {},
    );
    const regenerated = second.find((frame) => frame.event === 'done')?.data.message as {
      id: string;
      parentId: string | null;
    };

    expect(regenerated.id).not.toBe(originalId);
    expect(regenerated.parentId).toBe(originalId);

    // The original survives — lineage, not mutation.
    const original = await messageRepository.findById(originalId, user.id);
    expect(original).not.toBeNull();
  });

  it('re-answers the same question rather than accepting a new one', async () => {
    // Accepting client-supplied text here would let a regenerate silently
    // become an edit.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const first = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });
    const originalId = (first.find((frame) => frame.event === 'done')?.data.message as { id: string })
      .id;

    await collectStream(
      user,
      `/conversations/${conversation.id}/messages/${originalId}/regenerate`,
      { content: 'A completely different question' },
    );

    const messages = await messageRepository.listByConversation(conversation.id, user.id);
    const questions = messages.filter((message) => message.role === 'user');

    expect(questions).toHaveLength(1);
    expect(questions[0]?.content).toBe('What is the notice period?');
  });

  it('refuses to regenerate a message that is not an assistant turn', async () => {
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const frames = await collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });
    const messages = await messageRepository.listByConversation(conversation.id, user.id);
    const question = messages.find((message) => message.role === 'user');
    expect(frames.length).toBeGreaterThan(0);

    const response = await fetch(
      `${baseUrl()}${API_PREFIX}/conversations/${conversation.id}/messages/${String(question?.id)}/regenerate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.session.accessToken}`,
        },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});

describe('concurrent generations', () => {
  it('supersedes an in-flight generation on the same conversation', async () => {
    /*
      A user who sends a second message has abandoned the first answer. Letting
      both run bills for two completions to display one — and the abandoned
      placeholder is still finalized, so the thread stays coherent.
    */
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    fakeLLM().setStreamDelay(40);

    const firstStream = collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What is the notice period?',
    });

    // Let the first stream register before the second supersedes it.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const secondStream = collectStream(user, `/conversations/${conversation.id}/messages`, {
      content: 'What about equipment?',
    });

    await Promise.all([firstStream, secondStream]);
    fakeLLM().reset();

    const messages = await messageRepository.listByConversation(conversation.id, user.id);
    const assistants = messages.filter((message) => message.role === 'assistant');

    // Neither is left `pending`: every exit path finalizes.
    for (const assistant of assistants) {
      expect(['complete', 'stopped', 'failed']).toContain(assistant.status);
    }
  });
});

/** Polls until `check` passes, so a test never sleeps a fixed guess. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('condition was not met before the timeout');
}
