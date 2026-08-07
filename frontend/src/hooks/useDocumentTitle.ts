import { useEffect } from 'react';

/**
 * Sets the document title for the lifetime of a route.
 *
 * Restores the previous value on unmount so a back navigation cannot leave a
 * stale title in the tab — the usual symptom of setting `document.title`
 * directly in a component body.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
