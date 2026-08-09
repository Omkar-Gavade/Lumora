import { describe, expect, it, vi } from 'vitest';
import type { ConversationDetailDto, ConversationDto, ConversationListDto, TurnDto } from '@lumora/shared';
import { llmProvider } from '../../src/providers/llm/llm.factory.js';
import { FakeLLMProvider } from '../../src/providers/llm/fake.provider.js';
import { ProviderError } from '../../src/providers/llm/llm-provider.interface.js';
import { citationRepository } from '../../src/repositories/citation.repository.js';
import { messageRepository } from '../../src/repositories/message.repository.js';
import { chatService } from '../../src/services/chat/chat.service.js';
import { usageRepository } from '../../src/repositories/usage.repository.js';
import { IngestionWorker } from '../../src/workers/ingestion.worker.js';
import { API_PREFIX, request } from '../helpers/app.js';
import { db } from '../helpers/database.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { createTestUser, createVerifiedUser, type TestUser } from '../factories/user.factory.js';

/**
 * The chat orchestrator end to end (docs/05-rag-and-chat.md §7).
 *
 * Runs on the fake LLM, the fake embedding provider, and the in-memory vector
 * store — all deterministic. The fake answers *from the prompt it is given*,
 * citing each source, which is what makes citation mapping, validation, and
 * snapshotting assertable rather than a matter of hoping a real model
 * cooperates.
 *
 * `POST /conversations/:id/messages` answers JSON here rather than an SSE
 * stream. docs/04 §2.4 specifies the stream and it is the next milestone; the
 * turn lifecycle below is the same either way, which is exactly why
 * docs/06-roadmap.md sequences the non-streaming turn first.
 */

const CORPUS = [
  '# Employment Agreement',
  '',
  '## 3. Termination',
  '',
  'Either party may terminate this agreement with thirty days written notice delivered to the address of record. The notice period begins on the day after delivery is confirmed.',
  '',
  '## 4. Equipment',
  '',
  'Each employee is issued one ACME-1200/B workstation and replacement rails under part number RL-88.',
].join('\n');

/** The module-level provider the service uses, narrowed for scripting. */
function fakeLLM(): FakeLLMProvider {
  if (!(llmProvider instanceof FakeLLMProvider)) {
    throw new Error(
      `expected the fake LLM in tests, got "${llmProvider.name}" — check LLM_PROVIDER in the test environment`,
    );
  }
  return llmProvider;
}

async function seedCorpus(user: TestUser, body = CORPUS): Promise<string> {
  const document = await uploadDocument(user.session.accessToken, {
    bytes: FIXTURES.markdown(body),
    filename: uniqueFilename('.md'),
    contentType: 'text/markdown',
  });

  await new IngestionWorker({ workerId: 'chat-seed', concurrency: 1 }).drain();
  return document.id;
}

function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.session.accessToken}` };
}

async function newConversation(user: TestUser, title?: string): Promise<ConversationDto> {
  const response = await request()
    .post(`${API_PREFIX}/conversations`)
    .set(auth(user))
    .send(title === undefined ? {} : { title })
    .expect(201);

  return response.body as ConversationDto;
}

/**
 * The provider call that carried the turn's prompt.
 *
 * Identified by its content rather than by index, because titling is
 * fire-and-forget (§7 step 13) and its own `complete()` call lands in the same
 * array at an unpredictable moment. Asserting on `calls[0]` reads whichever
 * arrived first, which is a race dressed up as a test.
 */
function promptCall(): { role: string; content: string }[] {
  const call = fakeLLM().calls.find((entry) =>
    entry.messages.some((message) => message.content.includes('BEGIN SOURCES')),
  );

  if (call === undefined) throw new Error('no grounded prompt reached the provider');
  return call.messages;
}

/**
 * Runs a turn through the **non-streaming** endpoint.
 *
 * `POST /messages` is an SSE stream as of M6b; `/messages/sync` is the same
 * orchestration without the transport. These tests are about what the turn
 * decides — retrieval, prompt, citations, persistence — and asserting that
 * through a stream parser would test the parser as much as the decision.
 * Streaming has its own suite in `chat-stream.test.ts`.
 */
async function ask(user: TestUser, conversationId: string, content: string): Promise<TurnDto> {
  const response = await request()
    .post(`${API_PREFIX}/conversations/${conversationId}/messages/sync`)
    .set(auth(user))
    .send({ content })
    .expect(201);

  return response.body as TurnDto;
}

describe('conversation CRUD', () => {
  it('creates a conversation with a placeholder title', async () => {
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    expect(conversation.title).toBe('New conversation');
    // `false` is what lets the titler know it may name this thread.
    expect(conversation.titleGenerated).toBe(false);
    expect(conversation.messageCount).toBe(0);
  });

  it('accepts a caller-supplied title', async () => {
    const user = await createVerifiedUser();

    expect((await newConversation(user, 'Contract review')).title).toBe('Contract review');
  });

  it('lists a user’s conversations, most recently active first', async () => {
    const user = await createVerifiedUser();
    await seedCorpus(user);

    const first = await newConversation(user, 'First');
    const second = await newConversation(user, 'Second');

    // Activity, not creation, is what orders the sidebar.
    await ask(user, first.id, 'What is the notice period?');

    const response = await request()
      .get(`${API_PREFIX}/conversations`)
      .set(auth(user))
      .expect(200);

    const list = response.body as ConversationListDto;
    expect(list.items[0]?.id).toBe(first.id);
    expect(list.items.map((item) => item.id)).toContain(second.id);
  });

  it('returns a thread with its messages', async () => {
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    await ask(user, conversation.id, 'What is the notice period?');

    const response = await request()
      .get(`${API_PREFIX}/conversations/${conversation.id}`)
      .set(auth(user))
      .expect(200);

    const detail = response.body as ConversationDetailDto;
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    // Ordered by sequence, so the question is never rendered under its answer.
    expect(detail.messages[0]?.sequence).toBeLessThan(detail.messages[1]?.sequence ?? 0);
  });

  it('renames a conversation and marks the title as chosen', async () => {
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    const response = await request()
      .patch(`${API_PREFIX}/conversations/${conversation.id}`)
      .set(auth(user))
      .send({ title: 'Renamed by hand' })
      .expect(200);

    const updated = response.body as ConversationDto;
    expect(updated.title).toBe('Renamed by hand');
    // So the titler never overwrites a name the user picked.
    expect(updated.titleGenerated).toBe(true);
  });

  it('archives and unarchives', async () => {
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    await request()
      .patch(`${API_PREFIX}/conversations/${conversation.id}`)
      .set(auth(user))
      .send({ archived: true })
      .expect(200);

    const hidden = (
      await request().get(`${API_PREFIX}/conversations`).set(auth(user)).expect(200)
    ).body as ConversationListDto;
    expect(hidden.items.map((item) => item.id)).not.toContain(conversation.id);

    const shown = (
      await request()
        .get(`${API_PREFIX}/conversations?includeArchived=true`)
        .set(auth(user))
        .expect(200)
    ).body as ConversationListDto;
    expect(shown.items.map((item) => item.id)).toContain(conversation.id);
  });

  it('rejects an empty patch', async () => {
    // A client bug worth naming rather than a no-op worth silently accepting.
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    await request()
      .patch(`${API_PREFIX}/conversations/${conversation.id}`)
      .set(auth(user))
      .send({})
      .expect(422);
  });

  it('deletes a conversation and cascades its messages', async () => {
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);
    await ask(user, conversation.id, 'What is the notice period?');

    await request()
      .delete(`${API_PREFIX}/conversations/${conversation.id}`)
      .set(auth(user))
      .expect(204);

    expect(await messageRepository.listByConversation(conversation.id, user.id)).toEqual([]);
  });

  it('deletes a turn pair, not a lone message', async () => {
    // A question and its answer are one unit to the reader; deleting only the
    // question leaves an answer to nothing.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);
    const turn = await ask(user, conversation.id, 'What is the notice period?');

    await request()
      .delete(`${API_PREFIX}/messages/${turn.userMessage.id}`)
      .set(auth(user))
      .expect(204);

    expect(await messageRepository.listByConversation(conversation.id, user.id)).toEqual([]);
  });

  it('never exposes another user’s conversation', async () => {
    // A 404, not a 403: a 403 would confirm the id is real, which is what an
    // IDOR probe is looking for.
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const conversation = await newConversation(owner);

    await request()
      .get(`${API_PREFIX}/conversations/${conversation.id}`)
      .set(auth(stranger))
      .expect(404);
    await request()
      .patch(`${API_PREFIX}/conversations/${conversation.id}`)
      .set(auth(stranger))
      .send({ title: 'stolen' })
      .expect(404);
    await request()
      .delete(`${API_PREFIX}/conversations/${conversation.id}`)
      .set(auth(stranger))
      .expect(404);
  });

  it('requires authentication and verification', async () => {
    await request().get(`${API_PREFIX}/conversations`).expect(401);

    // FR-5: an unverified account keeps the shell but cannot use the corpus.
    const unverified = await createTestUser();
    await request().get(`${API_PREFIX}/conversations`).set(auth(unverified)).expect(403);
  });
});

describe('the turn lifecycle', () => {
  it('answers a question from the corpus, with citations', async () => {
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const turn = await ask(user, conversation.id, 'What is the notice period?');

    expect(turn.abstained).toBe(false);
    expect(turn.assistantMessage.status).toBe('complete');
    expect(turn.assistantMessage.content.length).toBeGreaterThan(0);
    expect(turn.assistantMessage.citations.length).toBeGreaterThan(0);
    expect(turn.sources.length).toBeGreaterThan(0);
  });

  it('writes both messages in one transaction, before the model is called', async () => {
    /*
      §7 step 3, and the reason: "A design that only writes the assistant
      message on successful completion loses everything on a disconnect and
      leaves the thread with a user turn and no reply."

      Asserted through the failure path — the model throws, and the rows are
      still there.
    */
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    fakeLLM().scriptNext(new ProviderError('fake', 'model exploded', true, 503));

    await request()
      .post(`${API_PREFIX}/conversations/${conversation.id}/messages/sync`)
      .set(auth(user))
      .send({ content: 'What is the notice period?' })
      .expect(502);

    const messages = await messageRepository.listByConversation(conversation.id, user.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.status).toBe('failed');
    expect(messages[1]?.errorCode).toBe('PROVIDER_ERROR');

    fakeLLM().reset();
  });

  it('persists the citations it mapped', async () => {
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const turn = await ask(user, conversation.id, 'What is the notice period?');
    const stored = await citationRepository.findByMessage(turn.assistantMessage.id);

    expect(stored.length).toBe(turn.assistantMessage.citations.length);
    expect(stored.length).toBeGreaterThan(0);
  });

  it('snapshots the cited text, so a deleted document leaves the answer verifiable', async () => {
    /*
      §5 defence 4. The link cascades away with the document; the snapshot
      survives on the citation row via the message.
    */
    const user = await createVerifiedUser();
    const documentId = await seedCorpus(user);
    const conversation = await newConversation(user);

    const turn = await ask(user, conversation.id, 'What is the notice period?');
    const before = await citationRepository.findByMessage(turn.assistantMessage.id);
    expect(before[0]?.contentSnapshot.length).toBeGreaterThan(0);

    await request()
      .delete(`${API_PREFIX}/documents/${documentId}`)
      .set(auth(user))
      .expect(204);

    const detail = (
      await request()
        .get(`${API_PREFIX}/conversations/${conversation.id}`)
        .set(auth(user))
        .expect(200)
    ).body as ConversationDetailDto;

    // The message survives and still reads correctly. The citation rows
    // cascade with the chunk, which is the documented privacy behaviour.
    const assistant = detail.messages.find((message) => message.role === 'assistant');
    expect(assistant?.content.length).toBeGreaterThan(0);
  });

  it('records model, tokens, and latency on the message', async () => {
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const turn = await ask(user, conversation.id, 'What is the notice period?');
    const stored = await messageRepository.findById(turn.assistantMessage.id, user.id);

    expect(stored?.model).toBe(llmProvider.model);
    expect(stored?.promptTokens).toBeGreaterThan(0);
    expect(stored?.completionTokens).toBeGreaterThan(0);
    expect(stored?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(stored?.finishReason).toBe('stop');
  });

  it('records a usage event so cost is visible', async () => {
    // docs/06-roadmap.md R3.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    await ask(user, conversation.id, 'What is the notice period?');

    const summary = await usageRepository.summaryFor(user.id);
    expect(summary.some((entry) => entry.kind === 'completion')).toBe(true);
  });

  it('bumps the conversation counters', async () => {
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    await ask(user, conversation.id, 'What is the notice period?');

    const detail = (
      await request()
        .get(`${API_PREFIX}/conversations/${conversation.id}`)
        .set(auth(user))
        .expect(200)
    ).body as ConversationDetailDto;

    expect(detail.conversation.messageCount).toBe(2);
    expect(detail.conversation.lastMessageAt).not.toBeNull();
  });

  it('numbers sources as the answer cites them', async () => {
    /*
      §4.2: "the model's `[2]` and the user's `[2]` are the same passage
      without a remapping step that could drift."
    */
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    const turn = await ask(user, conversation.id, 'What is the notice period?');

    for (const citation of turn.assistantMessage.citations) {
      const source = turn.sources.find((entry) => entry.index === citation.citationIndex);
      expect(source?.chunkId).toBe(citation.chunkId);
    }
  });

  it('strips a citation that references no source', async () => {
    // §5 defence 3: "A citation the user can click and find empty is worse
    // than no citation."
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    fakeLLM().scriptNext('A real claim [1]. An invented one [99].');

    const turn = await ask(user, conversation.id, 'What is the notice period?');

    expect(turn.assistantMessage.content).not.toContain('[99]');
    expect(turn.assistantMessage.citations.map((c) => c.citationIndex)).toEqual([1]);

    fakeLLM().reset();
  });

  it('sends the retrieved sources to the model', async () => {
    // ChatService performs no retrieval of its own — it consumes the evidence
    // bundle. This asserts the bundle actually reached the prompt.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    fakeLLM().reset();
    await ask(user, conversation.id, 'What is the notice period?');

    const system = promptCall()[0]?.content ?? '';
    expect(system).toContain('BEGIN SOURCES');
    expect(system).toContain('notice');

    fakeLLM().reset();
  });

  it('rejects an empty message', async () => {
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    await request()
      .post(`${API_PREFIX}/conversations/${conversation.id}/messages/sync`)
      .set(auth(user))
      .send({ content: '   ' })
      .expect(422);
  });

  it('refuses to post into another user’s conversation', async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const conversation = await newConversation(owner);

    await request()
      .post(`${API_PREFIX}/conversations/${conversation.id}/messages/sync`)
      .set(auth(stranger))
      .send({ content: 'What is the notice period?' })
      .expect(404);
  });
});

describe('abstention', () => {
  it('never calls the model when the corpus is empty', async () => {
    /*
      §3.3: "Not calling the model is strictly better than asking it not to
      answer — it is faster, free, and cannot be talked out of abstaining by a
      persuasive-sounding question."
    */
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    fakeLLM().reset();
    const turn = await ask(user, conversation.id, 'What is the notice period?');

    expect(turn.abstained).toBe(true);
    expect(turn.assistantMessage.content).toContain("haven't uploaded any documents");
    expect(turn.assistantMessage.citations).toEqual([]);
    // The decisive assertion: zero provider calls.
    expect(fakeLLM().calls).toHaveLength(0);
  });

  it('finalizes the assistant message rather than leaving a placeholder', async () => {
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    const turn = await ask(user, conversation.id, 'anything at all');
    const stored = await messageRepository.findById(turn.assistantMessage.id, user.id);

    expect(stored?.status).toBe('complete');
    expect(stored?.finishReason).toBe('abstained');
  });
});

describe('conversation history', () => {
  it('includes earlier turns in the prompt', async () => {
    // §4.4: "Last 6 turns verbatim."
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    await ask(user, conversation.id, 'What is the notice period?');

    fakeLLM().reset();
    await ask(user, conversation.id, 'And what about equipment?');

    // system, prior user turn, prior assistant turn, new question.
    expect(promptCall().map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);

    fakeLLM().reset();
  });

  it('excludes the placeholder created by the current turn', async () => {
    // It is in the table with empty content; including it would put a blank
    // assistant turn between the history and the question.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    fakeLLM().reset();
    await ask(user, conversation.id, 'What is the notice period?');

    expect(promptCall().filter((message) => message.content === '')).toHaveLength(0);

    fakeLLM().reset();
  });

  it('never puts the current question in the prompt twice', async () => {
    /*
      The question is written to the table before the prompt is built (§7 step
      3), so an unbounded history query returns it — and the builder then sends
      it as context *and* as the question. The model reads that as the user
      having asked the same thing twice.
    */
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    fakeLLM().reset();
    await ask(user, conversation.id, 'What is the notice period?');

    const questions = promptCall().filter(
      (message) => message.content === 'What is the notice period?',
    );
    expect(questions).toHaveLength(1);

    fakeLLM().reset();
  });

  it('excludes a failed reply from history', async () => {
    // Feeding a half-finished answer back as context teaches the model to
    // produce half-finished answers.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    fakeLLM().scriptNext(new ProviderError('fake', 'down', true, 503));
    await request()
      .post(`${API_PREFIX}/conversations/${conversation.id}/messages/sync`)
      .set(auth(user))
      .send({ content: 'first question' })
      .expect(502);

    fakeLLM().reset();
    await ask(user, conversation.id, 'second question');

    expect(promptCall().every((message) => message.content.length > 0)).toBe(true);

    fakeLLM().reset();
  });
});

describe('titling', () => {
  it('names an untitled conversation from its first question', async () => {
    // §7 step 13, fire-and-forget on the cheapest model, ≤6 words.
    const user = await createVerifiedUser();
    await seedCorpus(user);
    const conversation = await newConversation(user);

    fakeLLM().reset();
    await chatService.sendMessage({
      userId: user.id,
      conversationId: conversation.id,
      content: 'What is the notice period?',
    });
    // Titling is fire-and-forget, so it is awaited explicitly here rather than
    // slept on — a sleep would be a race dressed up as a test.
    await chatService.maybeTitle(conversation.id, user.id, 'What is the notice period?');

    const row = await db
      .selectFrom('conversations')
      .select(['title', 'title_generated'])
      .where('id', '=', conversation.id)
      .executeTakeFirstOrThrow();

    expect(row.title_generated).toBe(true);
    expect(row.title.split(' ').length).toBeLessThanOrEqual(6);
    // Derived from the question, not from whatever the model said about
    // sources — see `FakeLLMProvider` for why that distinction is load-bearing.
    expect(row.title).toBe('What the notice period');

    fakeLLM().reset();
  });

  it('never overwrites a title the user chose', async () => {
    /*
      Guarded on `title_generated = false` in SQL rather than by a preceding
      read: titling runs concurrently with the turn, and a user renaming the
      thread mid-flight must win.
    */
    const user = await createVerifiedUser();
    const conversation = await newConversation(user, 'My chosen name');

    await chatService.maybeTitle(conversation.id, user.id, 'What is the notice period?');

    const row = await db
      .selectFrom('conversations')
      .select('title')
      .where('id', '=', conversation.id)
      .executeTakeFirstOrThrow();

    expect(row.title).toBe('My chosen name');
  });

  it('never fails a turn when titling fails', async () => {
    // "A titling failure must never fail a turn that already produced a good
    // answer."
    const user = await createVerifiedUser();
    const conversation = await newConversation(user);

    const spy = vi
      .spyOn(llmProvider, 'complete')
      .mockRejectedValue(new Error('titling model unavailable'));

    await expect(
      chatService.maybeTitle(conversation.id, user.id, 'a question'),
    ).resolves.toBeUndefined();

    spy.mockRestore();
  });
});
