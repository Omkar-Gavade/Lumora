import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentListDto, ListDocumentsQuery, StorageUsageDto } from '@lumora/shared';
import { queryKeys } from '@/app/config/query-keys';
import {
  deleteDocument,
  getStorageUsage,
  listDocuments,
  uploadDocuments,
} from '../api/documents.api';

/**
 * Query and mutation wrappers holding cache keys, invalidation, and side
 * effects (docs/02-frontend.md §6, Tier 3). Components never call the API
 * functions directly.
 */

export function useDocuments(filters: Partial<ListDocumentsQuery> = {}) {
  return useQuery<DocumentListDto>({
    queryKey: queryKeys.documents.list(filters),
    queryFn: () => listDocuments(filters),
  });
}

export function useStorageUsage() {
  return useQuery<StorageUsageDto>({
    queryKey: queryKeys.documents.usage(),
    queryFn: getStorageUsage,
  });
}

export function useUploadDocuments() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (files: File[]) => uploadDocuments(files),
    onSuccess: () => {
      /*
        Invalidate the whole `documents` subtree, not just the unfiltered list.

        An upload changes the list, every status-filtered variant of it, and
        the usage meter. Invalidating one key would leave the sidebar showing
        stale bytes and a filtered view missing the file that was just added —
        which reads as the upload having failed.
      */
      void client.invalidateQueries({ queryKey: queryKeys.documents.all() });
    },
  });
}

export function useDeleteDocument() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteDocument(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.documents.all() });
    },
  });
}
