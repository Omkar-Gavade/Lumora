import type {
  AddKnowledgeBaseDocumentsResultDto,
  KnowledgeBaseDocumentsDto,
  KnowledgeBaseDto,
  KnowledgeBaseListDto,
} from '@lumora/shared';
import { db } from '../../db/pool.js';
import { NotFoundError } from '../../domain/errors/resource-errors.js';
import { toDocumentDto } from '../../domain/entities/document.js';
import { documentRepository } from '../../repositories/document.repository.js';
import {
  knowledgeBaseRepository,
  type KnowledgeBase,
} from '../../repositories/knowledge-base.repository.js';

function toDto(base: KnowledgeBase): KnowledgeBaseDto {
  return {
    id: base.id,
    name: base.name,
    description: base.description,
    documentCount: base.documentCount,
    createdAt: base.createdAt.toISOString(),
    updatedAt: base.updatedAt.toISOString(),
  };
}

/**
 * Knowledge Base business rules (docs/07-knowledge-base.md).
 *
 * A Knowledge Base groups documents and nothing else. It owns no chunks, no
 * vectors, and no retrieval logic — `documentIdsFor` hands a list of document
 * ids to the existing pipeline, which has accepted exactly that shape since
 * M4c. That is the whole integration.
 *
 * **Every method takes `userId` and every lookup is scoped to it.** A base
 * belonging to someone else is indistinguishable from one that does not exist,
 * because the repository query returns no row and this layer turns that into a
 * 404 (docs/04-data-and-api.md §4 — a 403 would confirm the id is real).
 */
export const knowledgeBaseService = {
  async create(
    userId: string,
    input: { name: string; description?: string | undefined },
  ): Promise<KnowledgeBaseDto> {
    return toDto(await knowledgeBaseRepository.create(userId, input));
  },

  async list(userId: string): Promise<KnowledgeBaseListDto> {
    const bases = await knowledgeBaseRepository.listByUser(userId);
    return { items: bases.map(toDto) };
  },

  async get(userId: string, knowledgeBaseId: string): Promise<KnowledgeBaseDto> {
    return toDto(await this.requireOwned(userId, knowledgeBaseId));
  },

  async update(
    userId: string,
    knowledgeBaseId: string,
    changes: { name?: string | undefined; description?: string | null | undefined },
  ): Promise<KnowledgeBaseDto> {
    const updated = await knowledgeBaseRepository.update(knowledgeBaseId, userId, changes);
    if (updated === null) throw new NotFoundError('Knowledge base not found.');

    return toDto(updated);
  },

  /**
   * Deletes the base. Documents are never touched.
   *
   * Memberships cascade away with the base, and conversations scoped to it are
   * set to `NULL` by the foreign key — they survive as unscoped conversations
   * rather than being deleted alongside a filing decision.
   */
  async delete(userId: string, knowledgeBaseId: string): Promise<void> {
    const deleted = await knowledgeBaseRepository.delete(knowledgeBaseId, userId);
    if (!deleted) throw new NotFoundError('Knowledge base not found.');
  },

  /** How many conversations a delete would turn unscoped, for the confirmation. */
  async affectedConversationCount(userId: string, knowledgeBaseId: string): Promise<number> {
    await this.requireOwned(userId, knowledgeBaseId);
    return knowledgeBaseRepository.countScopedConversations(knowledgeBaseId, userId);
  },

  async listDocuments(userId: string, knowledgeBaseId: string): Promise<KnowledgeBaseDocumentsDto> {
    await this.requireOwned(userId, knowledgeBaseId);

    const documentIds = await knowledgeBaseRepository.documentIdsIn(knowledgeBaseId, userId);
    const documents = await Promise.all(
      documentIds.map((id) => documentRepository.findById(id, userId)),
    );

    return {
      items: documents.filter((document) => document !== null).map(toDocumentDto),
    };
  },

  /**
   * Adds documents, rejecting the whole request if any is not the caller's.
   *
   * The insert itself is ownership-safe in SQL, so a foreign document simply
   * produces no row. This layer turns that silence into a 404 rather than a
   * partial success, because a client that asked to add five documents and got
   * "added: 4" has no way to learn which one failed or why — and telling it
   * *which* would confirm that a particular id belongs to somebody.
   */
  async addDocuments(
    userId: string,
    knowledgeBaseId: string,
    documentIds: string[],
  ): Promise<AddKnowledgeBaseDocumentsResultDto> {
    await this.requireOwned(userId, knowledgeBaseId);

    const requested = [...new Set(documentIds)];

    /*
      All of it, or none of it — and that needs a transaction.

      The insert is ownership-safe on its own: a document that is not the
      caller's contributes no row. But "some of the batch was refused" is only
      discoverable by counting *after* the insert, and without a transaction
      the rows that did qualify are already committed by the time the count
      says the request should fail. The result is a 404 that nonetheless
      changed the database — the worst of both answers.
    */
    return db.transaction().execute(async (trx) => {
      // Counted before the insert: afterwards, "already a member" and "not
      // allowed" are both zero inserted rows and cannot be told apart.
      const alreadyPresent = await knowledgeBaseRepository.countExistingMemberships(
        knowledgeBaseId,
        userId,
        requested,
        trx,
      );

      const inserted = await knowledgeBaseRepository.addDocuments(
        knowledgeBaseId,
        userId,
        requested,
        trx,
      );

      if (inserted.length + alreadyPresent < requested.length) {
        // Rolls the insert back. Deliberately does not say *which* id was
        // rejected — that would confirm a particular id belongs to somebody.
        throw new NotFoundError('One or more documents were not found.');
      }

      const base = await knowledgeBaseRepository.findById(knowledgeBaseId, userId, trx);

      return {
        added: inserted.length,
        alreadyPresent,
        documentCount: base?.documentCount ?? 0,
      };
    });
  },

  /**
   * Removes a membership. **Never deletes the document.**
   *
   * Removing something that is not a member succeeds: DELETE is idempotent and
   * the caller's desired state — "this document is not in this base" — is
   * already true. The base itself must still exist and be theirs.
   */
  async removeDocument(
    userId: string,
    knowledgeBaseId: string,
    documentId: string,
  ): Promise<void> {
    await this.requireOwned(userId, knowledgeBaseId);
    await knowledgeBaseRepository.removeDocument(knowledgeBaseId, userId, documentId);
  },

  /**
   * The retrieval scope for a base — **the single integration point with RAG**.
   *
   * Derived from the membership table under the caller's own id, never taken
   * from a request. A client-supplied document list would be an authorization
   * decision made by the client, which is the shape of every IDOR.
   *
   * An empty result is returned as an empty array and must stay one: the
   * retrieval contract reads `[]` as "scoped to nothing" and `undefined` as
   * "unscoped", and collapsing the two would answer an empty Knowledge Base
   * from the user's whole corpus (docs/07 §6.3).
   */
  async documentIdsFor(userId: string, knowledgeBaseId: string): Promise<string[]> {
    return knowledgeBaseRepository.documentIdsIn(knowledgeBaseId, userId);
  },

  /** 404 for both "no such base" and "not yours" — the distinction is not disclosed. */
  async requireOwned(userId: string, knowledgeBaseId: string): Promise<KnowledgeBase> {
    const base = await knowledgeBaseRepository.findById(knowledgeBaseId, userId);
    if (base === null) throw new NotFoundError('Knowledge base not found.');

    return base;
  },
};
