import type { ListDocumentsQuery } from '@lumora/shared';

/**
 * The central key factory (docs/02-frontend.md §5.1).
 *
 * Hierarchical, so `invalidateQueries({ queryKey: queryKeys.documents.all() })`
 * correctly sweeps every dependent query — the list, every filtered variant,
 * and each detail. Ad-hoc string keys make that a guessing game, and the
 * symptom is a list that does not refresh after an upload.
 */
export const queryKeys = {
  auth: {
    me: () => ['auth', 'me'] as const,
  },
  documents: {
    all: () => ['documents'] as const,
    list: (filters?: Partial<ListDocumentsQuery>) => ['documents', 'list', filters ?? {}] as const,
    detail: (id: string) => ['documents', 'detail', id] as const,
    usage: () => ['documents', 'usage'] as const,
  },
} as const;
