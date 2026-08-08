import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api/errors';

/**
 * TanStack Query, with the defaults from docs/02-frontend.md §5.1.
 *
 * Server state is not client state: it is remote, shared, cached, and stale by
 * default. Query owns caching, dedup, retry, and invalidation — all of which
 * would otherwise be hand-written badly around every fetch.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        /**
         * One retry, and **never on a 4xx**. Retrying a 401, a 403, or a
         * validation error is pure latency: the answer will not change, and
         * the user waits three times as long to be told the same thing.
         */
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 1;
        },
        refetchOnWindowFocus: true,
      },
      mutations: {
        // A mutation is not idempotent by default. Retrying an upload would
        // send the bytes twice.
        retry: false,
      },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  // Created in state, not at module scope: a module-level client is shared
  // across every test and every server render, so one suite's cache leaks
  // into the next.
  const [client] = useState(createQueryClient);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
