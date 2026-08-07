import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * `⌘` on Apple platforms, `Ctrl` everywhere else.
 *
 * Read through `useSyncExternalStore` with a never-changing subscription so the
 * value is computed during render rather than in an effect — a shortcut hint
 * that says "Ctrl" for one frame and then flips to "⌘" is a visible stutter in
 * the header on every load.
 */
/** The platform never changes mid-session, so there is nothing to subscribe to. */
const neverChanges = () => () => undefined;

export function useModifierKey(): string {
  return useSyncExternalStore(
    neverChanges,
    // `navigator.platform` is deprecated; the user-agent string still carries
    // "Macintosh"/"iPhone" and is the remaining reliable signal here. Getting
    // this wrong only mislabels a hint, so a heuristic is the right cost.
    () => (/mac|iphone|ipad|ipod/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'),
    () => '⌘',
  );
}

interface KbdProps {
  children: string;
  className?: string;
}

/**
 * A key cap. Monospace at micro size so `⌘K` and `Ctrl K` occupy predictable
 * width, and with no border — a bordered cap at 11px turns into a grey smudge
 * next to Inter.
 */
export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1',
        'bg-inset font-sans text-micro font-medium text-tertiary',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
