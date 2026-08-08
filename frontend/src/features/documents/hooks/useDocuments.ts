import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentListDto, ListDocumentsQuery, StorageUsageDto } from '@lumora/shared';
import { queryKeys } from '@/app/config/query-keys';
import { IN_PROGRESS } from '../components/DocumentRow';
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

/**
 * How often to re-read the list while any document is still processing.
 *
 * Two seconds is chosen against what the user is watching, not against server
 * cost: ingestion moves through four stages, and a poll slower than a stage
 * would skip labels entirely — a document would appear to jump from "Queued"
 * to "Ready" with nothing in between, which is exactly the undifferentiated
 * wait FR-13 exists to avoid.
 *
 * docs/04-data-and-api.md §2.3 specifies `GET /documents/events` (SSE) for
 * this. That endpoint is not built yet; polling is the honest interim, and it
 * is confined to this one line so adopting the stream later is a replacement
 * rather than a rewrite.
 */
const PROCESSING_POLL_MS = 2_000;

export function useDocuments(filters: Partial<ListDocumentsQuery> = {}) {
  return useQuery<DocumentListDto>({
    queryKey: queryKeys.documents.list(filters),
    queryFn: () => listDocuments(filters),
    /*
      Polls only while something is actually in flight, and stops the moment
      every document is `ready` or `failed`.

      A fixed interval would keep a settled library refetching forever — every
      open tab, all day, for a list that cannot change on its own. Gating on the
      data means the common case costs nothing.
    */
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((document) => IN_PROGRESS.includes(document.status))
        ? PROCESSING_POLL_MS
        : false;
    },
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
