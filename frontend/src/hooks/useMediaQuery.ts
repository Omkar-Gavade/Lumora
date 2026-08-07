import { useSyncExternalStore } from 'react';

/**
 * `useSyncExternalStore` rather than `useState` + `useEffect`.
 *
 * The effect version renders once with a guessed value and then corrects it,
 * which is exactly the flash the shell must not have: the sidebar would mount
 * expanded on a phone and snap shut a frame later. This subscribes to the
 * `MediaQueryList` and reads it synchronously during render, so the first
 * paint is already right.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = (onChange: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  };

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // Server snapshot. There is no SSR today; returning `false` keeps the hook
    // safe if the marketing route is ever prerendered.
    () => false,
  );
}

/** Tailwind's `md` — below this the sidebar becomes an overlay drawer. */
export const MEDIA_BELOW_MD = '(max-width: 767px)';
/** Tailwind's `lg` — at and above this the sidebar is permanent and expanded. */
export const MEDIA_AT_LEAST_LG = '(min-width: 1024px)';
