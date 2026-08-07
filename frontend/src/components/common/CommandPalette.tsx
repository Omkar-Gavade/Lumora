import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/app/router/routes';
import { NAV_ITEMS } from '@/app/config/navigation';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { Kbd } from '@/components/ui/Kbd';

interface Command {
  id: string;
  label: string;
  icon: LucideIcon;
  to: string;
  group: string;
}

/**
 * Actions first, destinations second. Someone who reaches for ⌘K with no query
 * is far more often starting something than looking for a page.
 */
const COMMANDS: Command[] = [
  { id: 'new-chat', label: 'New chat', icon: Plus, to: ROUTES.chat, group: 'Actions' },
  ...NAV_ITEMS.map((item) => ({
    id: `go-${item.to}`,
    label: `Go to ${item.label}`,
    icon: item.icon,
    to: item.to,
    group: 'Navigation',
  })),
];

interface CommandPaletteProps {
  onClose: () => void;
}

/**
 * The command palette.
 *
 * Scoped, deliberately, to what the shell can actually do today: navigate, and
 * start a chat. It does not search documents or conversations, because there
 * is no index behind it yet — a palette that accepts any query and always
 * answers "no results" teaches people it is broken, and they stop pressing ⌘K
 * before the feature that needs them to know it ever ships.
 *
 * Implemented as a combobox over a listbox rather than a menu: the input keeps
 * focus the whole time and `aria-activedescendant` moves the *virtual* cursor,
 * which is what lets someone keep typing while arrowing through results. A
 * roving `.focus()` would pull focus out of the field on every keystroke.
 *
 * Mounted only while open, and the caller is what mounts it. That is why there
 * is no `open` prop and no code anywhere resetting the query: unmounting *is*
 * the reset. Keeping it mounted and hidden would mean reopening onto the last
 * search, which is the behavior that makes people clear the field before they
 * can start.
 */
export function CommandPalette({ onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${String(index)}`;

  useLockBodyScroll(true);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return COMMANDS;
    return COMMANDS.filter((command) => command.label.toLowerCase().includes(needle));
  }, [query]);

  // Focus the field on mount. The dialog exists to be typed into, so there is
  // nothing else here that focus could reasonably land on.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(activeIndex))}`)
      ?.scrollIntoView({ block: 'nearest' });
    // `optionId` closes over a stable `useId`, so it is not a real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  const commit = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    void navigate(command.to);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) =>
          results.length === 0 ? 0 : (index - 1 + results.length) % results.length,
        );
        break;
      case 'Enter':
        event.preventDefault();
        commit(results[activeIndex]);
        break;
      case 'Tab':
        // One focusable element inside a modal layer: Tab has nowhere to go,
        // and letting it escape would leave the dialog open behind the page.
        event.preventDefault();
        break;
      default:
        break;
    }
  };

  const groups = [...new Set(results.map((command) => command.group))];

  return (
    <div className="fixed inset-0 z-70">
      {/* Dismissal by clicking away, for pointer users. Escape covers the
          keyboard, and the scrim is aria-hidden so it is never a tab stop. */}
      <div className="fade-in absolute inset-0 bg-scrim" aria-hidden="true" onClick={onClose} />

      {/*
        Positioned at 12% of the viewport rather than centred. A vertically
        centred palette sits where the eye is already reading and shifts down
        as results arrive; anchoring near the top keeps the input still while
        the list grows beneath it.
      */}
      <div className="absolute inset-x-0 top-[12vh] flex justify-center px-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          className={cn(
            'pop-in w-full max-w-xl overflow-hidden rounded-xl',
            'border border-line-default bg-raised shadow-e2',
          )}
        >
          <div className="flex h-13 items-center gap-2.5 border-b border-line px-4">
            <Search className="size-[1.125rem] shrink-0 text-tertiary" strokeWidth={1.5} aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                // The result set just changed under the cursor, so the
                // highlight comes home in the same commit rather than in a
                // follow-up render triggered by an effect.
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={results.length > 0 ? optionId(activeIndex) : undefined}
              aria-label="Search commands and pages"
              placeholder="Search commands and pages…"
              className={cn(
                'h-full flex-1 bg-transparent text-body-sm text-primary outline-none',
                'placeholder:text-tertiary',
              )}
            />
            <Kbd className="shrink-0">Esc</Kbd>
          </div>

          <div ref={listRef} id={listboxId} role="listbox" aria-label="Results" className="scroll-region max-h-80 overflow-y-auto p-2">
            {results.length === 0 ? (
              <div className="px-2.5 py-8 text-center">
                <p className="text-body-sm text-secondary">No matches</p>
                <p className="mt-1 text-caption text-tertiary">
                  Searching inside documents and conversations is coming soon.
                </p>
              </div>
            ) : (
              groups.map((group) => (
                <div key={group} className="pb-1 last:pb-0">
                  <p className="px-2.5 pt-2 pb-1 text-micro font-medium tracking-[0.06em] text-tertiary uppercase">
                    {group}
                  </p>

                  {results.map((command, index) =>
                    command.group !== group ? null : (
                      /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus --
                         Options in an `aria-activedescendant` combobox must NOT
                         be focusable and must NOT carry their own key handlers:
                         focus stays in the input, which owns the arrow keys and
                         Enter, and the option is identified to assistive tech by
                         id. Making these tabbable — which is what both rules ask
                         for — would break the pattern they are trying to protect
                         by pulling focus out of the field on every arrow press. */
                      <div
                        key={command.id}
                        id={optionId(index)}
                        role="option"
                        aria-selected={index === activeIndex}
                        // Pointer drives the same highlight the keyboard does,
                        // so the two never disagree about what Enter will open.
                        onMouseMove={() => setActiveIndex(index)}
                        onClick={() => commit(command)}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2',
                          'text-body-sm transition-colors duration-100',
                          index === activeIndex
                            ? 'bg-hover text-primary'
                            : 'text-secondary',
                        )}
                      >
                        <command.icon
                          className={cn(
                            'size-4 shrink-0',
                            index === activeIndex ? 'text-secondary' : 'text-tertiary',
                          )}
                          strokeWidth={1.5}
                          aria-hidden="true"
                        />
                        <span className="truncate">{command.label}</span>
                      </div>
                    ),
                  )}
                </div>
              ))
            )}
          </div>

          <div className="flex items-center gap-4 border-t border-line px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-caption text-tertiary">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              navigate
            </span>
            <span className="flex items-center gap-1.5 text-caption text-tertiary">
              <Kbd>↵</Kbd>
              open
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
