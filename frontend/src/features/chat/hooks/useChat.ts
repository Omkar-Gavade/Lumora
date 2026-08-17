import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConversationDetailDto,
  ConversationListDto,
  TurnDto,
} from '@lumora/shared';
import { queryKeys } from '@/app/config/query-keys';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
  sendMessage,
} from '../api/chat.api';

/**
 * Query and mutation wrappers holding cache keys, invalidation, and side
 * effects (docs/02-frontend.md §6, Tier 3). Components never call the API
 * functions directly.
 */

export function useConversations() {
  return useQuery<ConversationListDto>({
    queryKey: queryKeys.conversations.list(),
    queryFn: () => listConversations(),
  });
}

export function useConversation(id: string | undefined) {
  return useQuery<ConversationDetailDto>({
    queryKey: queryKeys.conversations.detail(id ?? ''),
    queryFn: () => getConversation(id ?? ''),
    // A thread with no id is the "new conversation" state, which has nothing
    // to fetch.
    enabled: id !== undefined && id.length > 0,
  });
}

export function useCreateConversation() {
  const client = useQueryClient();

  return useMutation({
    /*
      An options object rather than positional arguments: a conversation can
      now be created with a title, a knowledge base, both, or neither, and
      `createConversation(undefined, id)` is the call site that eventually
      passes them in the wrong order.
    */
    mutationFn: (input?: { title?: string; knowledgeBaseId?: string }) =>
      createConversation(input?.title, input?.knowledgeBaseId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.conversations.all() });
    },
  });
}

export function useRenameConversation() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameConversation(id, title),
    onSuccess: () => {
      // The whole subtree: a rename changes the sidebar row and the thread
      // header, and invalidating one would leave the other stale.
      void client.invalidateQueries({ queryKey: queryKeys.conversations.all() });
    },
  });
}

export function useDeleteConversation() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.conversations.all() });
    },
  });
}

/**
 * Sends a turn.
 *
 * **A mutation, not a query**, and not merely because it writes: `useQuery`
 * would re-run on focus and reconnect, and each re-run is a retrieval plus a
 * completion — the most expensive operation in the product
 * (docs/06-roadmap.md R3). A turn happens when the user presses send, and
 * never otherwise.
 */
export function useSendMessage() {
  const client = useQueryClient();

  return useMutation<TurnDto, Error, { conversationId: string; content: string }>({
    mutationFn: ({ conversationId, content }) => sendMessage(conversationId, content),
    onSuccess: (_turn, variables) => {
      /*
        Both the thread and the list.

        The thread gains two messages; the list reorders, because activity is
        what sorts the sidebar, and the title may have changed under it —
        titling is fire-and-forget on the server and lands shortly after the
        answer does.
      */
      void client.invalidateQueries({
        queryKey: queryKeys.conversations.detail(variables.conversationId),
      });
      void client.invalidateQueries({ queryKey: queryKeys.conversations.list() });
    },
  });
}
