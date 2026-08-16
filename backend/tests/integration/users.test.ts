import { describe, expect, it, vi } from 'vitest';
import { userRepository } from '../../src/repositories/user.repository.js';
import { mailProvider } from '../../src/providers/mail/mail.factory.js';
import { vectorStore } from '../../src/providers/vector/vector.factory.js';
import { documentService } from '../../src/services/documents/document.service.js';
import { IngestionWorker } from '../../src/workers/ingestion.worker.js';
import { API_PREFIX, request } from '../helpers/app.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { createVerifiedUser, type TestUser } from '../factories/user.factory.js';
import { asCookieHeader } from '../helpers/cookies.js';

/**
 * Account self-service (docs/04-data-and-api.md §2.2, docs/00-product.md
 * FR-34/36/37).
 *
 * The security assertions matter more than the happy paths here: these are the
 * only endpoints that can change a credential or destroy an account, and both
 * are reachable with nothing but a stolen access token.
 */

const STRONG = 'Replacement-Passphrase-9174';

function auth(user: TestUser) {
  return `Bearer ${user.session.accessToken}`;
}

describe('GET /users/me', () => {
  it('returns the caller’s own profile', async () => {
    const user = await createVerifiedUser();
    const response = await request()
      .get(`${API_PREFIX}/users/me`)
      .set('Authorization', auth(user))
      .expect(200);

    expect(response.body).toMatchObject({ id: user.id, email: user.email });
  });

  it('never serves a password hash or token', async () => {
    /*
      Asserted on the serialized body rather than on named fields: a future
      column added to the row and passed through a spread would not be caught
      by checking the fields we already know about.
    */
    const user = await createVerifiedUser();
    const response = await request()
      .get(`${API_PREFIX}/users/me`)
      .set('Authorization', auth(user))
      .expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('$argon2');
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/token_version|tokenVersion/);
  });

  it('rejects an unauthenticated request', async () => {
    await request().get(`${API_PREFIX}/users/me`).expect(401);
  });
});

describe('PATCH /users/me', () => {
  it('updates the display name', async () => {
    const user = await createVerifiedUser();
    const response = await request()
      .patch(`${API_PREFIX}/users/me`)
      .set('Authorization', auth(user))
      .send({ displayName: 'Renamed Person' })
      .expect(200);

    expect(response.body).toMatchObject({ displayName: 'Renamed Person' });
  });

  it('rejects an empty display name', async () => {
    const user = await createVerifiedUser();
    await request()
      .patch(`${API_PREFIX}/users/me`)
      .set('Authorization', auth(user))
      .send({ displayName: '   ' })
      .expect(422);
  });

  it('ignores an attempt to change the email', async () => {
    /*
      FR-34 makes email read-only in Phase 1. `validate` replaces the body with
      the parsed output, so an unknown key is stripped rather than reaching the
      service — this asserts the stripping actually happens, because the failure
      mode is a silent account takeover vector, not an error.
    */
    const user = await createVerifiedUser();
    await request()
      .patch(`${API_PREFIX}/users/me`)
      .set('Authorization', auth(user))
      .send({ displayName: 'Still Fine', email: 'attacker@evil.test' })
      .expect(200);

    const stored = await userRepository.findById(user.id);
    expect(stored?.email).toBe(user.email);
  });

  it('rejects an unauthenticated request', async () => {
    await request().patch(`${API_PREFIX}/users/me`).send({ displayName: 'x' }).expect(401);
  });
});

describe('POST /users/me/password', () => {
  it('changes the password and lets the new one sign in', async () => {
    const user = await createVerifiedUser();

    await request()
      .post(`${API_PREFIX}/users/me/password`)
      .set('Authorization', auth(user))
      .send({ currentPassword: user.password, newPassword: STRONG })
      .expect(204);

    await request()
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: user.email, password: STRONG })
      .expect(200);
  });

  it('refuses a wrong current password', async () => {
    const user = await createVerifiedUser();

    await request()
      .post(`${API_PREFIX}/users/me/password`)
      .set('Authorization', auth(user))
      .send({ currentPassword: 'not-the-password', newPassword: STRONG })
      .expect(401);

    // And the old password still works — a refused change must change nothing.
    await request()
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
  });

  it('refuses to reuse the current password as the new one', async () => {
    const user = await createVerifiedUser();

    await request()
      .post(`${API_PREFIX}/users/me/password`)
      .set('Authorization', auth(user))
      .send({ currentPassword: user.password, newPassword: user.password })
      .expect(422);
  });

  it('revokes every existing session', async () => {
    /*
      docs §2.2: "revokes other sessions". The point of a password change is
      usually that someone else may hold a session — leaving them alive makes
      the change cosmetic.
    */
    const user = await createVerifiedUser();

    await request()
      .post(`${API_PREFIX}/users/me/password`)
      .set('Authorization', auth(user))
      .send({ currentPassword: user.password, newPassword: STRONG })
      .expect(204);

    // The access token that made the change is now dead too: `updatePassword`
    // bumps `token_version`, which is the only way to kill a self-contained JWT.
    await request().get(`${API_PREFIX}/users/me`).set('Authorization', auth(user)).expect(401);

    /*
      And the refresh family is revoked too.

      Asserted explicitly because a mutation proved it had to be: deleting the
      `revokeAllForUser` call broke nothing, since bumping `token_version`
      already killed the access token above and no test looked further. That
      left the longer-lived credential — the one an attacker would actually
      keep — alive after a password change.
    */
    await request()
      .post(`${API_PREFIX}/auth/refresh`)
      .set('Cookie', asCookieHeader(user.refreshToken))
      .expect(401);
  });

  it('rejects a weak new password', async () => {
    const user = await createVerifiedUser();
    await request()
      .post(`${API_PREFIX}/users/me/password`)
      .set('Authorization', auth(user))
      .send({ currentPassword: user.password, newPassword: 'short' })
      .expect(422);
  });

  it('rejects an unauthenticated request', async () => {
    await request()
      .post(`${API_PREFIX}/users/me/password`)
      .send({ currentPassword: 'a', newPassword: STRONG })
      .expect(401);
  });
});

describe('DELETE /users/me', () => {
  it('requires the password', async () => {
    const user = await createVerifiedUser();

    await request()
      .delete(`${API_PREFIX}/users/me`)
      .set('Authorization', auth(user))
      .send({ password: 'wrong' })
      .expect(401);

    expect(await userRepository.findById(user.id)).not.toBeNull();
  });

  it('deletes the account and cascades the user’s data', async () => {
    const user = await createVerifiedUser();
    await uploadDocument(user.session.accessToken, {
      bytes: FIXTURES.markdown('# Notes\n\nSomething retrievable.\n'),
      filename: uniqueFilename('.md'),
      contentType: 'text/markdown',
    });
    await new IngestionWorker({ workerId: 'delete-acct', concurrency: 1 }).drain();

    await request()
      .delete(`${API_PREFIX}/users/me`)
      .set('Authorization', auth(user))
      .send({ password: user.password })
      .expect(204);

    expect(await userRepository.findById(user.id)).toBeNull();
    // FR-36: documents cascade with the account.
    await expect(documentService.list(user.id, { limit: 10 })).resolves.toMatchObject({ items: [] });
  });

  it('kills the session immediately', async () => {
    const user = await createVerifiedUser();

    await request()
      .delete(`${API_PREFIX}/users/me`)
      .set('Authorization', auth(user))
      .send({ password: user.password })
      .expect(204);

    // The access token is still cryptographically valid — its subject is gone.
    // Anything but a 401 here means a deleted account can still act.
    await request().get(`${API_PREFIX}/users/me`).set('Authorization', auth(user)).expect(401);
  });

  it('rejects an unauthenticated request', async () => {
    await request().delete(`${API_PREFIX}/users/me`).send({ password: 'x' }).expect(401);
  });
});

describe('GET /users/me/usage', () => {
  it('reports the caller’s own usage', async () => {
    const user = await createVerifiedUser();
    const response = await request()
      .get(`${API_PREFIX}/users/me/usage`)
      .set('Authorization', auth(user))
      .expect(200);

    expect(response.body).toMatchObject({ documentCount: 0, usedBytes: 0 });
  });

  it('never counts another user’s documents', async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();

    await uploadDocument(owner.session.accessToken, {
      bytes: FIXTURES.markdown('# Owned\n\nBelongs to the first user.\n'),
      filename: uniqueFilename('.md'),
      contentType: 'text/markdown',
    });

    const response = await request()
      .get(`${API_PREFIX}/users/me/usage`)
      .set('Authorization', auth(stranger))
      .expect(200);

    expect(response.body).toMatchObject({ documentCount: 0, usedBytes: 0 });
  });
});

describe('cross-user isolation', () => {
  it('gives every caller their own account, with no id to tamper with', async () => {
    /*
      There is no `:id` on any of these routes, so IDOR is prevented by shape
      rather than by a check that could be forgotten. This asserts the shape
      holds: two callers hitting the identical URL get different accounts.
    */
    const first = await createVerifiedUser();
    const second = await createVerifiedUser();

    const a = await request()
      .get(`${API_PREFIX}/users/me`)
      .set('Authorization', auth(first))
      .expect(200);
    const b = await request()
      .get(`${API_PREFIX}/users/me`)
      .set('Authorization', auth(second))
      .expect(200);

    expect(a.body.id).toBe(first.id);
    expect(b.body.id).toBe(second.id);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('cannot change another user’s password with a valid own session', async () => {
    // The stranger's own password is not the victim's, and there is nowhere in
    // the request to name a victim — so this can only ever fail as a wrong
    // current password, never as a successful cross-account change.
    // Distinct passwords on purpose: the factory's default is shared, so
    // reusing it would make this pass for the wrong reason — the stranger
    // would simply be supplying their *own* correct current password.
    const victim = await createVerifiedUser({ password: 'Victim-Passphrase-4821' });
    const stranger = await createVerifiedUser();

    await request()
      .post(`${API_PREFIX}/users/me/password`)
      .set('Authorization', auth(stranger))
      .send({ currentPassword: victim.password, newPassword: STRONG })
      .expect(401);

    await request()
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: victim.email, password: victim.password })
      .expect(200);
  });
});

describe('failure paths that must not fail the operation', () => {
  it('completes the password change even when the notification email fails', async () => {
    /*
      The notification exists so a user who did *not* change their password
      finds out. Its delivery is not part of the change: rolling back because
      SMTP was briefly down would leave the account on the credential the user
      was trying to replace — a failure mode strictly worse than a missing
      email.
    */
    const user = await createVerifiedUser();
    const send = vi.spyOn(mailProvider, 'send').mockRejectedValue(new Error('smtp down'));

    try {
      await request()
        .post(`${API_PREFIX}/users/me/password`)
        .set('Authorization', auth(user))
        .send({ currentPassword: user.password, newPassword: STRONG })
        .expect(204);

      await request()
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: user.email, password: STRONG })
        .expect(200);
    } finally {
      send.mockRestore();
    }
  });

  it('deletes the account even when the vector store is unreachable', async () => {
    /*
      A Chroma outage must not trap a user in an account they asked to delete.
      The residue is orphaned vectors in a per-user collection that nothing can
      reach once the row is gone — an operational cleanup problem, not a
      privacy one that blocking would solve.
    */
    const user = await createVerifiedUser();
    const drop = vi
      .spyOn(vectorStore, 'deleteCollection')
      .mockRejectedValue(new Error('chroma unreachable'));

    try {
      await request()
        .delete(`${API_PREFIX}/users/me`)
        .set('Authorization', auth(user))
        .send({ password: user.password })
        .expect(204);

      expect(await userRepository.findById(user.id)).toBeNull();
    } finally {
      drop.mockRestore();
    }
  });

  it('rejects a token whose account no longer exists', async () => {
    // The other half of the token_version check: `findById` returning null.
    // A token that outlives its subject must not authenticate.
    const user = await createVerifiedUser();
    await userRepository.deleteById(user.id);

    await request().get(`${API_PREFIX}/users/me`).set('Authorization', auth(user)).expect(401);
  });
});
