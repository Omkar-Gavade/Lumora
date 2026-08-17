import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  KnowledgeBaseDocumentsDto,
  KnowledgeBaseDto,
  KnowledgeBaseListDto,
} from '@lumora/shared';
import { queryKeys } from '@/app/config/query-keys';
import {
  addKnowledgeBaseDocuments,
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  getKnowledgeBaseImpact,
  listKnowledgeBaseDocuments,
  listKnowledgeBases,
  removeKnowledgeBaseDocument,
  updateKnowledgeBase,
} from '../api/knowledge.api';

/**
 * Query and mutation wrappers holding cache keys and invalidation
 * (docs/02-frontend.md §5.1). Components never call the API functions.
 *
 * Invalidation is scoped rather than swept: a membership change touches one
 * base's document list and the list's counts, and nothing else. Broad
 * invalidation would refetch every conversation and document on the screen to
 * reflect a checkbox.
 */

export function useKnowledgeBases() {
  return useQuery<KnowledgeBaseListDto>({
    queryKey: queryKeys.knowledgeBases.list(),
    queryFn: listKnowledgeBases,
  });
}

export function useKnowledgeBase(id: string | undefined) {
  return useQuery<KnowledgeBaseDto>({
    queryKey: queryKeys.knowledgeBases.detail(id ?? ''),
    queryFn: () => getKnowledgeBase(id ?? ''),
    enabled: id !== undefined && id.length > 0,
  });
}

export function useKnowledgeBaseDocuments(id: string | undefined) {
  return useQuery<KnowledgeBaseDocumentsDto>({
    queryKey: queryKeys.knowledgeBases.documents(id ?? ''),
    queryFn: () => listKnowledgeBaseDocuments(id ?? ''),
    enabled: id !== undefined && id.length > 0,
  });
}

/**
 * How many conversations a delete would unscope.
 *
 * Fetched only when the confirmation is open — the number is worthless until
 * the user is deciding, and asking for it on every list render would add a
 * request per card.
 */
export function useKnowledgeBaseImpact(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.knowledgeBases.impact(id ?? ''),
    queryFn: () => getKnowledgeBaseImpact(id ?? ''),
    enabled: enabled && id !== undefined && id.length > 0,
  });
}

export function useCreateKnowledgeBase() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string; description?: string }) => createKnowledgeBase(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.knowledgeBases.list() });
    },
  });
}

export function useUpdateKnowledgeBase() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      changes,
    }: {
      id: string;
      changes: { name?: string; description?: string | null };
    }) => updateKnowledgeBase(id, changes),
    onSuccess: (_base, variables) => {
      // The card in the list and the header on the detail page both show the
      // name; invalidating one would leave the other stale.
      void client.invalidateQueries({ queryKey: queryKeys.knowledgeBases.list() });
      void client.invalidateQueries({
        queryKey: queryKeys.knowledgeBases.detail(variables.id),
      });
    },
  });
}

export function useDeleteKnowledgeBase() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteKnowledgeBase(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.knowledgeBases.all() });
      /*
        Conversations too: deleting a base sets `knowledge_base_id` to NULL on
        every conversation scoped to it, so a cached conversation would keep
        claiming a scope that no longer exists.
      */
      void client.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useAddKnowledgeBaseDocuments() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, documentIds }: { id: string; documentIds: string[] }) =>
      addKnowledgeBaseDocuments(id, documentIds),
    onSuccess: (_result, variables) => {
      void client.invalidateQueries({
        queryKey: queryKeys.knowledgeBases.documents(variables.id),
      });
      // The count lives on the base itself and on the list card.
      void client.invalidateQueries({
        queryKey: queryKeys.knowledgeBases.detail(variables.id),
      });
      void client.invalidateQueries({ queryKey: queryKeys.knowledgeBases.list() });
    },
  });
}

export function useRemoveKnowledgeBaseDocument() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, documentId }: { id: string; documentId: string }) =>
      removeKnowledgeBaseDocument(id, documentId),
    onSuccess: (_result, variables) => {
      void client.invalidateQueries({
        queryKey: queryKeys.knowledgeBases.documents(variables.id),
      });
      void client.invalidateQueries({
        queryKey: queryKeys.knowledgeBases.detail(variables.id),
      });
      void client.invalidateQueries({ queryKey: queryKeys.knowledgeBases.list() });
    },
  });
}
