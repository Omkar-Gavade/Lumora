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
  conversations: {
    all: () => ['conversations'] as const,
    list: () => ['conversations', 'list'] as const,
    detail: (id: string) => ['conversations', 'detail', id] as const,
  },
  documents: {
    all: () => ['documents'] as const,
    list: (filters?: Partial<ListDocumentsQuery>) => ['documents', 'list', filters ?? {}] as const,
    detail: (id: string) => ['documents', 'detail', id] as const,
    usage: () => ['documents', 'usage'] as const,
  },
  /*
    Hierarchical like the rest, so a membership change can invalidate one
    base's documents without sweeping every base's list — and so `all()` still
    catches everything when a base is created or deleted.
  */
  knowledgeBases: {
    all: () => ['knowledge-bases'] as const,
    list: () => ['knowledge-bases', 'list'] as const,
    detail: (id: string) => ['knowledge-bases', 'detail', id] as const,
    documents: (id: string) => ['knowledge-bases', 'detail', id, 'documents'] as const,
    impact: (id: string) => ['knowledge-bases', 'detail', id, 'impact'] as const,
  },
} as const;
