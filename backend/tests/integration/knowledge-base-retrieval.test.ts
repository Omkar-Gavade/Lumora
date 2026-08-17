import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationDto, KnowledgeBaseDto, TurnDto } from '@lumora/shared';
import { API_PREFIX, request } from '../helpers/app.js';
import { createVerifiedUser, type TestUser } from '../factories/user.factory.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { IngestionWorker } from '../../src/workers/ingestion.worker.js';

/**
 * The scope boundary (docs/07-knowledge-base.md §12).
 *
 * **This is the file that decides whether the feature is real.** Everything
 * else — CRUD, membership, the UI — is filing. What a user is promised is that
 * a conversation scoped to a Knowledge Base is answered from that base and
 * from nothing else, and these tests are the only thing that holds that
 * promise to account.
 *
 * The corpora are deliberately disjoint. A ranking preference would still put
 * the right document first; only a real boundary excludes the wrong one
 * entirely, and that is what is asserted.
 */

const MENTAL_HEALTH = `# Cognitive Behavioural Therapy

Cognitive behavioural therapy is a structured talking treatment. A course of
CBT usually runs for six to twenty sessions with a trained therapist. Thought
records are the central homework exercise in CBT.`;

const AWS = `# Amazon VPC

An Amazon VPC is a logically isolated virtual network. A VPC spans all
availability zones in a region. Subnets divide a VPC address range, and a
route table controls traffic between subnets.`;

function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.session.accessToken}` };
}

async function ingest(user: TestUser, body: string): Promise<string> {
  const document = await uploadDocument(user.session.accessToken, {
    bytes: FIXTURES.markdown(body),
    filename: uniqueFilename('.md'),
    contentType: 'text/markdown',
  });

  await new IngestionWorker({ workerId: 'kb-seed', concurrency: 1 }).drain();
  return document.id;
}

async function newBase(user: TestUser, name: string, documentIds: string[]): Promise<KnowledgeBaseDto> {
  const created = await request()
    .post(`${API_PREFIX}/knowledge-bases`)
    .set(auth(user))
    .send({ name })
    .expect(201);

  const base = created.body as KnowledgeBaseDto;

  if (documentIds.length > 0) {
    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds })
      .expect(200);
  }

  return base;
}

async function conversationIn(user: TestUser, knowledgeBaseId?: string): Promise<string> {
  const response = await request()
    .post(`${API_PREFIX}/conversations`)
    .set(auth(user))
    .send(knowledgeBaseId === undefined ? {} : { knowledgeBaseId })
    .expect(201);

  return (response.body as ConversationDto).id;
}

async function ask(user: TestUser, conversationId: string, content: string): Promise<TurnDto> {
  const response = await request()
    .post(`${API_PREFIX}/conversations/${conversationId}/messages/sync`)
    .set(auth(user))
    .send({ content })
    .expect(201);

  return response.body as TurnDto;
}

/** Which documents the evidence actually came from. */
function sourceDocuments(turn: TurnDto): string[] {
  return [...new Set((turn.sources ?? []).map((source) => source.documentId))].sort();
}

let user: TestUser;
let mentalHealthDoc: string;
let awsDoc: string;
let kbMentalHealth: KnowledgeBaseDto;
let kbAws: KnowledgeBaseDto;

beforeEach(async () => {
  user = await createVerifiedUser();
  mentalHealthDoc = await ingest(user, MENTAL_HEALTH);
  awsDoc = await ingest(user, AWS);

  kbMentalHealth = await newBase(user, 'Mental Health', [mentalHealthDoc]);
  kbAws = await newBase(user, 'AWS', [awsDoc]);
});

describe('scoped retrieval', () => {
  it('answers from the scoped base', async () => {
    const conversation = await conversationIn(user, kbMentalHealth.id);
    const turn = await ask(user, conversation, 'What is a thought record used for?');

    expect(sourceDocuments(turn)).toEqual([mentalHealthDoc]);
  });

  it('**never retrieves a document outside the scope, even when it is the better match**', async () => {
    /*
      The strongest assertion in the suite. The question is about AWS, the AWS
      document is indexed and would win on relevance, and the conversation is
      scoped to Mental Health. If the AWS document appears here at all, the
      scope is decoration.
    */
    const conversation = await conversationIn(user, kbMentalHealth.id);
    const turn = await ask(user, conversation, 'What is an AWS VPC?');

    expect(sourceDocuments(turn)).not.toContain(awsDoc);
  });

  it('excludes the mental-health document from an AWS-scoped conversation', async () => {
    // The inverse, so the result cannot be an artefact of which corpus is
    // lexically richer.
    const conversation = await conversationIn(user, kbAws.id);
    const turn = await ask(user, conversation, 'How many sessions does CBT usually take?');

    expect(sourceDocuments(turn)).not.toContain(mentalHealthDoc);
  });

  it('answers an AWS question from the AWS base', async () => {
    const conversation = await conversationIn(user, kbAws.id);
    const turn = await ask(user, conversation, 'What does a route table control?');

    expect(sourceDocuments(turn)).toEqual([awsDoc]);
  });

  it('**cites only documents inside the scope**', async () => {
    // Citations are the user-visible half of the boundary: an answer sourced
    // correctly but cited outside the base is still a broken promise.
    const conversation = await conversationIn(user, kbMentalHealth.id);
    const turn = await ask(user, conversation, 'What is cognitive behavioural therapy?');

    for (const citation of turn.assistantMessage.citations ?? []) {
      expect(citation.documentId).toBe(mentalHealthDoc);
    }
  });
});

describe('empty knowledge base', () => {
  it('**retrieves nothing rather than falling back to the whole corpus**', async () => {
    /*
      docs/07 §6.3 (D-1). Before the fix the vector half read an empty filter as
      "no filter" and returned everything the user owned, while the lexical half
      returned nothing — so an empty base was answered from documents it was
      never scoped to.
    */
    const empty = await newBase(user, 'Empty', []);
    const conversation = await conversationIn(user, empty.id);

    const turn = await ask(user, conversation, 'What is an AWS VPC?');

    expect(turn.sources ?? []).toEqual([]);
    expect(sourceDocuments(turn)).toEqual([]);
  });

  it('abstains rather than inventing an answer', async () => {
    const empty = await newBase(user, 'Empty', []);
    const conversation = await conversationIn(user, empty.id);

    const turn = await ask(user, conversation, 'What is an AWS VPC?');

    // The existing abstention contract, reached through the new scope.
    expect(turn.abstained).toBe(true);
  });
});

describe('unscoped regression', () => {
  it('still searches the whole corpus when there is no knowledge base', async () => {
    // The guarantee that this feature is additive. An unscoped conversation
    // must behave exactly as it did before Knowledge Base existed.
    const conversation = await conversationIn(user);
    const turn = await ask(user, conversation, 'What is an AWS VPC?');

    expect(sourceDocuments(turn)).toContain(awsDoc);
  });

  it('reaches the other corpus too, from the same unscoped conversation', async () => {
    const conversation = await conversationIn(user);
    const turn = await ask(user, conversation, 'What is cognitive behavioural therapy?');

    expect(sourceDocuments(turn)).toContain(mentalHealthDoc);
  });
});

describe('membership changes affect retrieval', () => {
  it('stops retrieving a document once it is removed from the base', async () => {
    const conversation = await conversationIn(user, kbAws.id);

    const before = await ask(user, conversation, 'What does a route table control?');
    expect(sourceDocuments(before)).toEqual([awsDoc]);

    await request()
      .delete(`${API_PREFIX}/knowledge-bases/${kbAws.id}/documents/${awsDoc}`)
      .set(auth(user))
      .expect(204);

    const after = await ask(user, conversation, 'What does a route table control?');
    expect(sourceDocuments(after)).toEqual([]);
  });

  it('reverts to the whole corpus when the base is deleted', async () => {
    // ON DELETE SET NULL: the conversation survives as unscoped rather than
    // being deleted or left pointing at nothing.
    const conversation = await conversationIn(user, kbMentalHealth.id);

    await request()
      .delete(`${API_PREFIX}/knowledge-bases/${kbMentalHealth.id}`)
      .set(auth(user))
      .expect(204);

    const turn = await ask(user, conversation, 'What is an AWS VPC?');

    expect(sourceDocuments(turn)).toContain(awsDoc);
  });
});
