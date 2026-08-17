import type {
  AddKnowledgeBaseDocumentsResultDto,
  KnowledgeBaseDocumentsDto,
  KnowledgeBaseDto,
  KnowledgeBaseListDto,
} from '@lumora/shared';
import { request } from '@/lib/api/client';

/** Transport only — no caching, no error mapping (docs/02-frontend.md §6). */

export async function listKnowledgeBases(): Promise<KnowledgeBaseListDto> {
  return request<KnowledgeBaseListDto>('/knowledge-bases');
}

export async function getKnowledgeBase(id: string): Promise<KnowledgeBaseDto> {
  return request<KnowledgeBaseDto>(`/knowledge-bases/${id}`);
}

export async function createKnowledgeBase(input: {
  name: string;
  description?: string;
}): Promise<KnowledgeBaseDto> {
  return request<KnowledgeBaseDto>('/knowledge-bases', { method: 'POST', body: input });
}

export async function updateKnowledgeBase(
  id: string,
  changes: { name?: string; description?: string | null },
): Promise<KnowledgeBaseDto> {
  return request<KnowledgeBaseDto>(`/knowledge-bases/${id}`, { method: 'PATCH', body: changes });
}

export async function deleteKnowledgeBase(id: string): Promise<void> {
  await request<undefined>(`/knowledge-bases/${id}`, { method: 'DELETE' });
}

/** What deleting would cost, for the confirmation copy. */
export async function getKnowledgeBaseImpact(id: string): Promise<{ conversationCount: number }> {
  return request<{ conversationCount: number }>(`/knowledge-bases/${id}/impact`);
}

export async function listKnowledgeBaseDocuments(id: string): Promise<KnowledgeBaseDocumentsDto> {
  return request<KnowledgeBaseDocumentsDto>(`/knowledge-bases/${id}/documents`);
}

export async function addKnowledgeBaseDocuments(
  id: string,
  documentIds: string[],
): Promise<AddKnowledgeBaseDocumentsResultDto> {
  return request<AddKnowledgeBaseDocumentsResultDto>(`/knowledge-bases/${id}/documents`, {
    method: 'POST',
    body: { documentIds },
  });
}

export async function removeKnowledgeBaseDocument(id: string, documentId: string): Promise<void> {
  await request<undefined>(`/knowledge-bases/${id}/documents/${documentId}`, { method: 'DELETE' });
}
