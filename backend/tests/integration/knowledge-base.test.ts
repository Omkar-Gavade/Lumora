import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationDto, KnowledgeBaseDto, KnowledgeBaseListDto } from '@lumora/shared';
import { API_PREFIX, request } from '../helpers/app.js';
import { db } from '../helpers/database.js';
import { createVerifiedUser, type TestUser } from '../factories/user.factory.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { knowledgeBaseRepository } from '../../src/repositories/knowledge-base.repository.js';

/**
 * Knowledge Base CRUD, membership, and isolation (docs/07-knowledge-base.md).
 *
 * The security tests here are the reason the feature is worth testing at all:
 * a Knowledge Base is a filing mechanism, but the code that resolves one into
 * a document list feeds retrieval, and a mistake in it puts another user's
 * document into an answer.
 */

function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.session.accessToken}` };
}

async function newBase(user: TestUser, name = 'Research'): Promise<KnowledgeBaseDto> {
  const response = await request()
    .post(`${API_PREFIX}/knowledge-bases`)
    .set(auth(user))
    .send({ name })
    .expect(201);

  return response.body as KnowledgeBaseDto;
}

async function newDocument(user: TestUser, body = 'The notice period is thirty days.') {
  return uploadDocument(user.session.accessToken, {
    bytes: FIXTURES.markdown(body),
    filename: uniqueFilename('.md'),
    contentType: 'text/markdown',
  });
}

let user: TestUser;
let other: TestUser;

beforeEach(async () => {
  user = await createVerifiedUser();
  other = await createVerifiedUser();
});

describe('knowledge base CRUD', () => {
  it('creates a base and returns it with a zero document count', async () => {
    const base = await newBase(user, 'Mental Health');

    expect(base.name).toBe('Mental Health');
    expect(base.documentCount).toBe(0);
    expect(base.description).toBeNull();
  });

  it('rejects an empty name', async () => {
    await request()
      .post(`${API_PREFIX}/knowledge-bases`)
      .set(auth(user))
      .send({ name: '   ' })
      .expect(422);
  });

  it('allows two bases with the same name', async () => {
    // Names are labels, not identifiers (docs/07 §10). Nothing joins on them.
    await newBase(user, 'AWS');
    await newBase(user, 'AWS');

    const response = await request()
      .get(`${API_PREFIX}/knowledge-bases`)
      .set(auth(user))
      .expect(200);

    expect((response.body as KnowledgeBaseListDto).items).toHaveLength(2);
  });

  it('lists only the caller’s bases', async () => {
    await newBase(user, 'Mine');
    await newBase(other, 'Theirs');

    const response = await request()
      .get(`${API_PREFIX}/knowledge-bases`)
      .set(auth(user))
      .expect(200);

    const names = (response.body as KnowledgeBaseListDto).items.map((item) => item.name);
    expect(names).toEqual(['Mine']);
  });

  it('renames and clears a description', async () => {
    const base = await newBase(user);

    await request()
      .patch(`${API_PREFIX}/knowledge-bases/${base.id}`)
      .set(auth(user))
      .send({ name: 'Renamed', description: 'Papers' })
      .expect(200);

    const cleared = await request()
      .patch(`${API_PREFIX}/knowledge-bases/${base.id}`)
      .set(auth(user))
      .send({ description: null })
      .expect(200);

    expect((cleared.body as KnowledgeBaseDto).name).toBe('Renamed');
    expect((cleared.body as KnowledgeBaseDto).description).toBeNull();
  });

  it('rejects a patch that changes nothing', async () => {
    const base = await newBase(user);

    await request()
      .patch(`${API_PREFIX}/knowledge-bases/${base.id}`)
      .set(auth(user))
      .send({})
      .expect(422);
  });

  it('deletes a base', async () => {
    const base = await newBase(user);

    await request().delete(`${API_PREFIX}/knowledge-bases/${base.id}`).set(auth(user)).expect(204);
    await request().get(`${API_PREFIX}/knowledge-bases/${base.id}`).set(auth(user)).expect(404);
  });
});

describe('knowledge base cross-tenant isolation', () => {
  /*
    404 everywhere, never 403 (docs/07 §8). A 403 confirms the id names a real
    resource, which is exactly what an IDOR probe is trying to learn.
  */

  it('hides another user’s base from read', async () => {
    const base = await newBase(other);

    await request().get(`${API_PREFIX}/knowledge-bases/${base.id}`).set(auth(user)).expect(404);
  });

  it('refuses to update another user’s base', async () => {
    const base = await newBase(other, 'Theirs');

    await request()
      .patch(`${API_PREFIX}/knowledge-bases/${base.id}`)
      .set(auth(user))
      .send({ name: 'Hijacked' })
      .expect(404);

    const row = await db
      .selectFrom('knowledge_bases')
      .select('name')
      .where('id', '=', base.id)
      .executeTakeFirstOrThrow();

    expect(row.name).toBe('Theirs');
  });

  it('refuses to delete another user’s base', async () => {
    const base = await newBase(other);

    await request().delete(`${API_PREFIX}/knowledge-bases/${base.id}`).set(auth(user)).expect(404);

    expect(
      await db
        .selectFrom('knowledge_bases')
        .select('id')
        .where('id', '=', base.id)
        .executeTakeFirst(),
    ).toBeDefined();
  });

  it('requires authentication', async () => {
    await request().get(`${API_PREFIX}/knowledge-bases`).expect(401);
  });
});

describe('document membership', () => {
  it('adds a document and reports the new count', async () => {
    const base = await newBase(user);
    const document = await newDocument(user);

    const response = await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds: [document.id] })
      .expect(200);

    expect(response.body).toMatchObject({ added: 1, alreadyPresent: 0, documentCount: 1 });
  });

  it('treats a duplicate add as a no-op rather than an error', async () => {
    // The composite primary key makes this idempotent by construction.
    const base = await newBase(user);
    const document = await newDocument(user);
    const payload = { documentIds: [document.id] };

    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send(payload)
      .expect(200);

    const second = await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send(payload)
      .expect(200);

    expect(second.body).toMatchObject({ added: 0, alreadyPresent: 1, documentCount: 1 });
  });

  it('**refuses to attach another user’s document, and writes nothing**', async () => {
    /*
      The single most important test in this file. The insert filters on
      `documents.user_id` inside the statement (docs/07 §8.1), so a foreign
      document contributes no row — and the service turns the shortfall into a
      404 rather than a partial success.
    */
    const base = await newBase(user);
    const foreign = await newDocument(other);

    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds: [foreign.id] })
      .expect(404);

    const memberships = await db
      .selectFrom('knowledge_base_documents')
      .select('document_id')
      .where('knowledge_base_id', '=', base.id)
      .execute();

    expect(memberships).toEqual([]);
  });

  it('rejects the whole batch when one document is foreign', async () => {
    // All-or-nothing: a partial success the client cannot interpret is worse
    // than a refusal it can.
    const base = await newBase(user);
    const mine = await newDocument(user);
    const foreign = await newDocument(other);

    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds: [mine.id, foreign.id] })
      .expect(404);

    expect(await knowledgeBaseRepository.documentIdsIn(base.id, user.id)).toEqual([]);
  });

  it('refuses to add to another user’s base', async () => {
    const base = await newBase(other);
    const document = await newDocument(user);

    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds: [document.id] })
      .expect(404);
  });

  it('404s for a document that does not exist', async () => {
    const base = await newBase(user);

    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds: ['019fe2e4-0000-7000-8000-0000000000ff'] })
      .expect(404);
  });

  it('lists the documents in a base', async () => {
    const base = await newBase(user);
    const document = await newDocument(user);

    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds: [document.id] })
      .expect(200);

    const response = await request()
      .get(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .expect(200);

    expect((response.body as { items: { id: string }[] }).items.map((d) => d.id)).toEqual([
      document.id,
    ]);
  });

  it('**removing a document from a base does not delete the document**', async () => {
    const base = await newBase(user);
    const document = await newDocument(user);

    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds: [document.id] })
      .expect(200);

    await request()
      .delete(`${API_PREFIX}/knowledge-bases/${base.id}/documents/${document.id}`)
      .set(auth(user))
      .expect(204);

    // Gone from the base…
    expect(await knowledgeBaseRepository.documentIdsIn(base.id, user.id)).toEqual([]);
    // …still in the library.
    await request().get(`${API_PREFIX}/documents/${document.id}`).set(auth(user)).expect(200);
  });

  it('removing a non-member succeeds, because DELETE is idempotent', async () => {
    const base = await newBase(user);
    const document = await newDocument(user);

    await request()
      .delete(`${API_PREFIX}/knowledge-bases/${base.id}/documents/${document.id}`)
      .set(auth(user))
      .expect(204);
  });

  it('**deleting a base does not delete its documents**', async () => {
    const base = await newBase(user);
    const document = await newDocument(user);

    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds: [document.id] })
      .expect(200);

    await request().delete(`${API_PREFIX}/knowledge-bases/${base.id}`).set(auth(user)).expect(204);

    await request().get(`${API_PREFIX}/documents/${document.id}`).set(auth(user)).expect(200);
    expect(
      await db
        .selectFrom('knowledge_base_documents')
        .select('document_id')
        .where('knowledge_base_id', '=', base.id)
        .execute(),
    ).toEqual([]);
  });

  it('deleting a document removes its memberships', async () => {
    const base = await newBase(user);
    const document = await newDocument(user);

    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds: [document.id] })
      .expect(200);

    await request().delete(`${API_PREFIX}/documents/${document.id}`).set(auth(user)).expect(204);

    expect(await knowledgeBaseRepository.documentIdsIn(base.id, user.id)).toEqual([]);
  });

  it('lets one document belong to several bases', async () => {
    // Many-to-many is the point (docs/07 §2.1) — no re-upload, no re-embedding.
    const first = await newBase(user, 'AWS');
    const second = await newBase(user, 'Security');
    const document = await newDocument(user);

    for (const base of [first, second]) {
      await request()
        .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
        .set(auth(user))
        .send({ documentIds: [document.id] })
        .expect(200);
    }

    expect(await knowledgeBaseRepository.documentIdsIn(first.id, user.id)).toEqual([document.id]);
    expect(await knowledgeBaseRepository.documentIdsIn(second.id, user.id)).toEqual([document.id]);

    const documents = await db.selectFrom('documents').select('id').where('user_id', '=', user.id).execute();
    expect(documents).toHaveLength(1);
  });
});

describe('conversation scoping', () => {
  it('creates an unscoped conversation by default', async () => {
    const response = await request()
      .post(`${API_PREFIX}/conversations`)
      .set(auth(user))
      .send({})
      .expect(201);

    expect((response.body as ConversationDto).knowledgeBaseId).toBeNull();
  });

  it('creates a conversation scoped to a base', async () => {
    const base = await newBase(user);

    const response = await request()
      .post(`${API_PREFIX}/conversations`)
      .set(auth(user))
      .send({ knowledgeBaseId: base.id })
      .expect(201);

    expect((response.body as ConversationDto).knowledgeBaseId).toBe(base.id);
  });

  it('refuses to scope a conversation to another user’s base', async () => {
    const base = await newBase(other);

    await request()
      .post(`${API_PREFIX}/conversations`)
      .set(auth(user))
      .send({ knowledgeBaseId: base.id })
      .expect(404);
  });

  it('allows changing the scope before the first message', async () => {
    const first = await newBase(user, 'A');
    const second = await newBase(user, 'B');

    const created = await request()
      .post(`${API_PREFIX}/conversations`)
      .set(auth(user))
      .send({ knowledgeBaseId: first.id })
      .expect(201);

    const updated = await request()
      .patch(`${API_PREFIX}/conversations/${(created.body as ConversationDto).id}`)
      .set(auth(user))
      .send({ knowledgeBaseId: second.id })
      .expect(200);

    expect((updated.body as ConversationDto).knowledgeBaseId).toBe(second.id);
  });

  it('**freezes the scope once the conversation has a message**', async () => {
    /*
      docs/07 §2.2. Persisted citations point at chunks retrieved under the old
      scope; letting the scope change afterwards makes the transcript a false
      claim about how its answers were produced.

      The guard is `message_count = 0` in the UPDATE, so a turn racing the
      change wins.
    */
    const base = await newBase(user);
    const created = await request()
      .post(`${API_PREFIX}/conversations`)
      .set(auth(user))
      .send({})
      .expect(201);

    const conversationId = (created.body as ConversationDto).id;

    await db
      .updateTable('conversations')
      .set({ message_count: 2 })
      .where('id', '=', conversationId)
      .execute();

    const response = await request()
      .patch(`${API_PREFIX}/conversations/${conversationId}`)
      .set(auth(user))
      .send({ knowledgeBaseId: base.id })
      .expect(409);

    expect((response.body as { error: { code: string } }).error.code).toBe('CONFLICT');

    const row = await db
      .selectFrom('conversations')
      .select('knowledge_base_id')
      .where('id', '=', conversationId)
      .executeTakeFirstOrThrow();

    expect(row.knowledge_base_id).toBeNull();
  });

  it('**deleting a base makes its conversations unscoped rather than deleting them**', async () => {
    const base = await newBase(user);
    const created = await request()
      .post(`${API_PREFIX}/conversations`)
      .set(auth(user))
      .send({ knowledgeBaseId: base.id })
      .expect(201);

    const conversationId = (created.body as ConversationDto).id;

    await request().delete(`${API_PREFIX}/knowledge-bases/${base.id}`).set(auth(user)).expect(204);

    const response = await request()
      .get(`${API_PREFIX}/conversations/${conversationId}`)
      .set(auth(user))
      .expect(200);

    expect((response.body as { conversation: ConversationDto }).conversation.knowledgeBaseId).toBeNull();
  });

  it('reports how many conversations a delete would unscope', async () => {
    const base = await newBase(user);

    for (const _ of [0, 1, 2]) {
      await request()
        .post(`${API_PREFIX}/conversations`)
        .set(auth(user))
        .send({ knowledgeBaseId: base.id })
        .expect(201);
    }

    const response = await request()
      .get(`${API_PREFIX}/knowledge-bases/${base.id}/impact`)
      .set(auth(user))
      .expect(200);

    expect(response.body).toEqual({ conversationCount: 3 });
  });
});

describe('account deletion', () => {
  it('removes knowledge bases and memberships with the user', async () => {
    // Cascades from `users`, like every other table the account owns. An
    // orphaned base would keep a row referencing a user that no longer exists.
    const base = await newBase(user);
    const document = await newDocument(user);

    await request()
      .post(`${API_PREFIX}/knowledge-bases/${base.id}/documents`)
      .set(auth(user))
      .send({ documentIds: [document.id] })
      .expect(200);

    await request()
      .delete(`${API_PREFIX}/users/me`)
      .set(auth(user))
      .send({ password: user.password })
      .expect(204);

    expect(
      await db.selectFrom('knowledge_bases').select('id').where('id', '=', base.id).executeTakeFirst(),
    ).toBeUndefined();

    expect(
      await db
        .selectFrom('knowledge_base_documents')
        .select('document_id')
        .where('knowledge_base_id', '=', base.id)
        .execute(),
    ).toEqual([]);
  });
});
