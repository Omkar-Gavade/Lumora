import type { DocumentDto } from './documents.js';

/**
 * A Knowledge Base as the API returns it (docs/07-knowledge-base.md §7).
 *
 * `documentCount` is computed rather than stored: a counter column would need
 * maintaining on every membership change and on every document delete, and the
 * one thing worse than a join is a denormalised count that has drifted.
 */
export interface KnowledgeBaseDto {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseListDto {
  items: KnowledgeBaseDto[];
}

/** The members of one Knowledge Base — full documents, not just ids. */
export interface KnowledgeBaseDocumentsDto {
  items: DocumentDto[];
}

/**
 * The result of a batch add.
 *
 * `alreadyPresent` is reported rather than treated as an error: the composite
 * primary key makes re-adding a no-op, and telling the client how many were
 * new lets the UI say something true without a second request.
 */
export interface AddKnowledgeBaseDocumentsResultDto {
  added: number;
  alreadyPresent: number;
  documentCount: number;
}
