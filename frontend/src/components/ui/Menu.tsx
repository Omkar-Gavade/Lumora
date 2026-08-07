import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

type Side = 'top' | 'bottom';
type Align = 'start' | 'end';

interface MenuContextValue {
  close: () => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

function useMenuContext(): MenuContextValue {
  const context = useContext(MenuContext);
  if (!context) throw new Error('Menu subcomponents must be rendered inside <Menu>.');
  return context;
}

/** Distance from the trigger, and the minimum breathing room at a viewport edge. */
const OFFSET = 8;
const EDGE_PADDING = 12;

interface MenuProps {
  /**
   * The control that opens the menu. Cloned rather than wrapped, so the menu
   * adds no extra DOM around the trigger and cannot disturb its layout — the
   * same `asChild` idiom `Button` uses.
   */
  trigger: ReactElement;
  children: ReactNode;
  /** Names the menu for screen readers, e.g. "Account". */
  label: string;
  side?: Side;
  align?: Align;
  className?: string;
}

/**
 * A dropdown menu, rendered into a portal.
 *
 * The portal is not incidental. This menu opens from the sidebar footer, and
 * the sidebar clips its own contents while collapsing — an in-place popover
 * would be sliced off at the panel edge. Portalling to `<body>` means the menu
 * is positionally independent of whatever it was opened from, permanently.
 *
 * Keyboard contract, which is the actual reason this component exists rather
 * than a `<div>` with an `onClick`:
 *   Enter/Space  open, focus lands on the first item
 *   ArrowDown/Up move between items, wrapping at both ends
 *   Home/End     first / last item
 *   Escape       close and return focus to the trigger
 *   Tab          close — a menu is a layer, not a stop in the page tab order
 *   click-away   close, and the originating click is not swallowed
 */
export function Menu({
  trigger,
  children,
  label,
  side = 'bottom',
  align = 'end',
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const triggerRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(() => {
    setOpen(false);
    // Focus goes back where it came from. Without this, dismissing a menu
    // drops a keyboard user at the top of the document.
    triggerRef.current?.focus();
  }, []);

  const items = useCallback(
    () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
      ),
    [],
  );

  /*
    Position in a layout effect, after the panel is in the DOM but before the
    browser paints. The panel renders hidden on the first pass so its width can
    be measured; measuring is what allows the clamp below, and the clamp is
    what stops a right-aligned menu from hanging off a narrow viewport.
  */
  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const anchor = triggerRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;

      const rect = anchor.getBoundingClientRect();

      /*
        The anchor can stop being rendered while its menu is open — the sidebar
        account row is `display: none` below `md`, so dragging a window across
        that breakpoint leaves the menu pointing at a zero-size rect and it
        slides into the top-left corner. A menu with no referent is meaningless,
        so it closes rather than repositioning to nowhere.
      */
      if (rect.width === 0 && rect.height === 0) {
        setOpen(false);
        return;
      }

      const { offsetWidth: width, offsetHeight: height } = panel;
      const { innerWidth: vw, innerHeight: vh } = window;

      // Flip to the other side when the preferred one does not fit.
      const fitsBelow = rect.bottom + OFFSET + height <= vh - EDGE_PADDING;
      const fitsAbove = rect.top - OFFSET - height >= EDGE_PADDING;
      const resolvedSide: Side =
        side === 'bottom' ? (fitsBelow || !fitsAbove ? 'bottom' : 'top') : fitsAbove || !fitsBelow ? 'top' : 'bottom';

      const top =
        resolvedSide === 'bottom' ? rect.bottom + OFFSET : Math.max(EDGE_PADDING, rect.top - OFFSET - height);

      const preferredLeft = align === 'start' ? rect.left : rect.right - width;
      const left = Math.min(Math.max(EDGE_PADDING, preferredLeft), vw - width - EDGE_PADDING);

      setStyle({
        position: 'fixed',
        top,
        left,
        maxHeight: vh - top - EDGE_PADDING,
        visibility: 'visible',
      });
    };

    place();
    window.addEventListener('resize', place);
    // Capture phase: the app shell scrolls inner regions, not the window, so a
    // bubbling listener on `window` would never hear them.
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, side, align]);

  // Focus the first item once the panel is placed — or the panel itself when
  // there are none, so a screen reader lands on the empty state rather than
  // being left on a trigger whose menu it never announces.
  useEffect(() => {
    if (!open) return;
    const first = items()[0];
    if (first) first.focus();
    else panelRef.current?.focus();
  }, [open, items]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Dismissal is handled before the item list is consulted. A menu whose
      // body is an empty state has no items, and an Escape that does nothing
      // because there was nothing to arrow through is a trapped user.
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === 'Tab') {
        setOpen(false);
        return;
      }

      const list = items();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLElement);

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          list[(index + 1) % list.length]?.focus();
          break;
        case 'ArrowUp':
          event.preventDefault();
          list[(index - 1 + list.length) % list.length]?.focus();
          break;
        case 'Home':
          event.preventDefault();
          list[0]?.focus();
          break;
        case 'End':
          event.preventDefault();
          list[list.length - 1]?.focus();
          break;
        default:
          break;
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // No `close()` here: focus belongs wherever the user just clicked, not
      // yanked back to the trigger they deliberately clicked away from.
      setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, items, close]);

  // Narrowed to an index-signature shape so the existing handler can be read
  // off `props` without reaching through `any`.
  const child = Children.only(trigger) as ReactElement<Record<string, unknown>>;
  if (!isValidElement(child)) {
    throw new Error('<Menu trigger> expects exactly one React element.');
  }

  /* eslint-disable-next-line react-hooks/refs --
     The ref is being *attached* to the cloned element, not read. `.current` is
     only ever touched in effects and event handlers below. The rule cannot
     tell the two apart when a ref is passed as a prop. */
  const triggerNode = cloneElement(child, {
    ref: triggerRef,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: (event: ReactMouseEvent) => {
      // The trigger keeps whatever handler it arrived with — the menu adds
      // behavior to a control, it does not take it over.
      (child.props.onClick as ((e: ReactMouseEvent) => void) | undefined)?.(event);
      setOpen((value) => !value);
    },
  });

  const context = useMemo<MenuContextValue>(() => ({ close: () => setOpen(false) }), []);

  return (
    <>
      {triggerNode}
      {open &&
        createPortal(
          <MenuContext.Provider value={context}>
            <div
              ref={panelRef}
              id={menuId}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              style={style}
              className={cn(
                'z-60 min-w-56 overflow-y-auto rounded-lg border border-line-default',
                'bg-raised p-1 shadow-e2 scroll-region',
                side === 'top' ? 'pop-in-up' : 'pop-in',
                className,
              )}
            >
              {children}
            </div>
          </MenuContext.Provider>,
          document.body,
        )}
    </>
  );
}

interface MenuItemProps {
  children: ReactNode;
  icon?: LucideIcon;
  /** Right-aligned hint — a shortcut, a count, a value. */
  hint?: ReactNode;
  onSelect?: () => void;
  /** Renders a react-router `<Link>` instead of a button. */
  to?: string;
  /** Renders an `<a>` — for genuinely external destinations. */
  href?: string;
  destructive?: boolean;
  disabled?: boolean;
}

export function MenuItem({
  children,
  icon: Icon,
  hint,
  onSelect,
  to,
  href,
  destructive = false,
  disabled = false,
}: MenuItemProps) {
  const { close } = useMenuContext();

  const classes = cn(
    'group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2',
    'text-body-sm outline-none select-none',
    'transition-colors duration-100 ease-[var(--ease-standard)]',
    // Menu items highlight on focus, not just hover: pointer and keyboard
    // users then see exactly the same "this one is next" affordance, and
    // arrowing through the menu is legible without a separate focus ring.
    destructive
      ? 'text-danger hover:bg-hover focus:bg-hover'
      : 'text-secondary hover:bg-hover hover:text-primary focus:bg-hover focus:text-primary',
    disabled && 'pointer-events-none opacity-50',
  );

  const content = (
    <>
      {Icon && <Icon className="size-4 shrink-0 text-tertiary group-hover:text-secondary group-focus:text-secondary" strokeWidth={1.5} aria-hidden="true" />}
      <span className="flex-1 truncate text-left">{children}</span>
      {hint && <span className="shrink-0 text-caption text-tertiary tabular">{hint}</span>}
    </>
  );

  const shared = {
    role: 'menuitem' as const,
    tabIndex: -1,
    className: classes,
    'aria-disabled': disabled || undefined,
  };

  if (to) {
    return (
      <Link {...shared} to={to} onClick={close}>
        {content}
      </Link>
    );
  }

  if (href) {
    return (
      <a {...shared} href={href} target="_blank" rel="noreferrer" onClick={close}>
        {content}
      </a>
    );
  }

  return (
    <button
      {...shared}
      type="button"
      disabled={disabled}
      onClick={() => {
        onSelect?.();
        close();
      }}
    >
      {content}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}

/** A non-interactive block at the top of a menu — the account identity row. */
export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="px-2.5 py-2">{children}</div>;
}

/** Small uppercase label grouping items within a menu. */
export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-2 pb-1 text-micro font-medium tracking-[0.06em] text-tertiary uppercase">
      {children}
    </div>
  );
}
