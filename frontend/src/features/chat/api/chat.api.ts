import type {
  ConversationDetailDto,
  ConversationDto,
  ConversationListDto,
  TurnDto,
} from '@lumora/shared';
import { request } from '@/lib/api/client';

/**
 * Typed request functions, one per endpoint (docs/02-frontend.md §6, Tier 2).
 *
 * Pure async functions with no React dependency, so they are testable without
 * a renderer and callable from anywhere.
 */

export async function listConversations(includeArchived = false): Promise<ConversationListDto> {
  const query = includeArchived ? '?includeArchived=true' : '';
  return request<ConversationListDto>(`/conversations${query}`);
}

export async function getConversation(id: string): Promise<ConversationDetailDto> {
  return request<ConversationDetailDto>(`/conversations/${id}`);
}

export async function createConversation(
  title?: string,
  knowledgeBaseId?: string,
): Promise<ConversationDto> {
  return request<ConversationDto>('/conversations', {
    method: 'POST',
    body: {
      ...(title === undefined ? {} : { title }),
      // Omitted rather than sent as null: the server reads an absent field as
      // "unscoped", which is the default the column already has.
      ...(knowledgeBaseId === undefined ? {} : { knowledgeBaseId }),
    },
  });
}

export async function renameConversation(id: string, title: string): Promise<ConversationDto> {
  return request<ConversationDto>(`/conversations/${id}`, {
    method: 'PATCH',
    body: { title },
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await request<undefined>(`/conversations/${id}`, { method: 'DELETE' });
}

/**
 * Sends one turn and waits for the whole answer.
 *
 * docs/04-data-and-api.md §2.4 specifies this endpoint as an SSE stream, and
 * it will be — the streaming orchestrator is the next milestone. The request
 * shape does not change when it arrives, so this call site becomes a stream
 * consumer rather than a different request.
 */
export async function sendMessage(conversationId: string, content: string): Promise<TurnDto> {
  return request<TurnDto>(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { content },
  });
}
