import { Search } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { IconButton } from '@/components/ui/IconButton';
import { Kbd, useModifierKey } from '@/components/ui/Kbd';

interface SearchTriggerProps {
  onOpen: () => void;
  className?: string;
}

/**
 * Search and the command palette are the same control.
 *
 * Shipping a search field *and* a ⌘K palette gives the header two boxes that
 * do overlapping things, and users learn neither. So this looks like an input
 * and behaves like a button: clicking it opens the palette, where the real
 * field lives and the keyboard is already primed.
 *
 * It is styled as a field rather than as a button on purpose — the affordance
 * has to read as "type here" to the people who will never learn the shortcut,
 * while the visible ⌘K teaches the shortcut to everyone who might.
 *
 * Below `lg` it becomes an icon. A field wide enough to be legible would take
 * the room the breadcrumb needs, and the palette it opens is full-screen there
 * anyway.
 */
export function SearchTrigger({ onOpen, className }: SearchTriggerProps) {
  const modifier = useModifierKey();

  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'hidden h-9 w-56 cursor-pointer items-center gap-2 rounded-md lg:inline-flex',
          'border border-line-default bg-canvas px-2.5 text-body-sm text-tertiary',
          'transition-[background-color,border-color,color] duration-150 ease-[var(--ease-standard)]',
          'hover:border-line-strong hover:text-secondary',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          className,
        )}
      >
        <Search className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        <span className="flex-1 text-left">Search</span>
        <Kbd>{`${modifier}K`}</Kbd>
      </button>

      <IconButton label="Search" onClick={onOpen} className="lg:hidden">
        <Search className="size-[1.125rem]" strokeWidth={1.5} aria-hidden="true" />
      </IconButton>
    </>
  );
}
