import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils/cn';

const OFFSET = 10;
const OPEN_DELAY = 350;

interface TooltipProps {
  /** The text. Always the same string as the child's accessible name. */
  label: string;
  children: ReactElement;
  side?: 'right' | 'top';
  /** Turns the tooltip off without changing the tree — how the sidebar stops
   *  showing tooltips the moment it is expanded and the labels are visible. */
  disabled?: boolean;
}

/**
 * A label for a control that has no visible one — specifically, the collapsed
 * sidebar rail.
 *
 * Three decisions worth stating:
 *
 * `aria-hidden` on the bubble. The tooltip repeats the control's accessible
 * name, so exposing it makes a screen reader say "Chat, Chat". A tooltip that
 * carries *new* information would need `aria-describedby`; this one does not.
 *
 * Mouse only, never touch. Opening is gated on `pointerType === 'mouse'`,
 * because on a touch device the "hover" that precedes a tap would flash a
 * bubble over the thing being tapped.
 *
 * 350ms delay in, none out. Without the delay, dragging the pointer down a
 * list of eight rail icons fires eight bubbles in a second.
 */
export function Tooltip({ label, children, side = 'right', disabled = false }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const anchorRef = useRef<HTMLElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
  }, []);

  // Clear a pending open if the element unmounts mid-delay.
  useEffect(() => cancel, [cancel]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;

    const rect = anchor.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = bubble;

    setStyle(
      side === 'right'
        ? {
            position: 'fixed',
            left: rect.right + OFFSET,
            top: Math.round(rect.top + rect.height / 2 - h / 2),
            visibility: 'visible',
          }
        : {
            position: 'fixed',
            left: Math.round(rect.left + rect.width / 2 - w / 2),
            top: rect.top - OFFSET - h,
            visibility: 'visible',
          },
    );
  }, [open, side]);

  // Escape dismisses, matching every other transient layer in the shell.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, cancel]);

  const child = Children.only(children) as ReactElement<Record<string, unknown>>;
  if (!isValidElement(child)) {
    throw new Error('<Tooltip> expects exactly one React element child.');
  }

  if (disabled) return child;

  /* eslint-disable-next-line react-hooks/refs --
     Attaching the ref to the cloned child, not reading it. `.current` is read
     only inside the layout effect that positions the bubble. */
  const anchorNode = cloneElement(child, {
    ref: anchorRef,
    onPointerEnter: (event: ReactPointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY);
    },
    onPointerLeave: cancel,
    onPointerDown: cancel,
    // Keyboard focus shows it immediately: a keyboard user has already
    // committed to this element, so there is nothing to debounce.
    onFocus: () => setOpen(true),
    onBlur: cancel,
  });

  return (
    <>
      {anchorNode}
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            aria-hidden="true"
            style={style}
            className={cn(
              'pointer-events-none z-70 rounded-md px-2 py-1',
              'bg-ink-solid text-caption font-medium whitespace-nowrap text-on-ink shadow-e2',
              'fade-in',
            )}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
