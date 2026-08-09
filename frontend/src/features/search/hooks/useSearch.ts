import { useMutation } from '@tanstack/react-query';
import type { EvidenceBundleDto } from '@lumora/shared';
import { search, type SearchParams } from '../api/search.api';

/**
 * Runs a retrieval.
 *
 * **A mutation, not a query**, despite reading data. TanStack's `useQuery`
 * would re-run on window focus, on reconnect, and on any key change — firing
 * an embedding call each time, which costs real money
 * (docs/06-roadmap.md R3). A search is a deliberate action with a submit
 * button, and `useMutation` is the hook whose semantics say "runs when asked".
 *
 * No cache key for the same reason: caching a bundle would hide the very thing
 * this page exists to observe, which is what retrieval does *right now* after
 * a document was re-ingested or a parameter changed.
 */
export function useSearch() {
  return useMutation<EvidenceBundleDto, Error, SearchParams>({
    mutationFn: (params) => search(params),
  });
}
