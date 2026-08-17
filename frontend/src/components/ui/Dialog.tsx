import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { IconButton } from './IconButton';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Right-aligned action row. The confirming control goes last. */
  footer?: ReactNode;
  /** `lg` for the document picker, which is a list rather than a form. */
  size?: 'md' | 'lg';
}

/**
 * A modal dialog.
 *
 * The design system had no dialog primitive — `Menu`, `Tooltip`,
 * `CommandPalette`, and the mobile drawer each hand-rolled a portal and their
 * own focus management. A fourth copy for Knowledge Base would have been the
 * duplication this codebase otherwise avoids, so the behaviour is extracted
 * here once (docs/07-knowledge-base.md §4.2, O-2).
 *
 * The mechanics are the mobile drawer's, because that implementation is
 * already correct and already reviewed: focus moves in on open, Tab cycles
 * inside, Escape closes, the scrim is a pointer convenience rather than a
 * control, and the page behind cannot scroll.
 *
 * Mounted on open rather than kept hidden. Unlike the drawer there is no
 * close animation to preserve, and a dialog that stays in the tree keeps its
 * form state from the last time it was opened — which for a create form means
 * yesterday's half-typed name reappearing.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useLockBodyScroll(open);

  // Focus enters the dialog on open. Without it the next Tab continues from
  // whatever opened it, behind the scrim.
  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    const firstField = panel?.querySelector<HTMLElement>('input, textarea, select');

    // The first field when there is one — a create form exists to be typed
    // into — and the close button otherwise.
    (firstField ?? closeRef.current)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-70 flex items-end justify-center sm:items-center">
      {/* Opacity only. A backdrop blur here costs a full-screen GPU pass to
          obscure content the panel already covers. */}
      <div onClick={onClose} aria-hidden="true" className="absolute inset-0 bg-scrim" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description === undefined ? {} : { 'aria-describedby': descriptionId })}
        className={cn(
          'relative flex max-h-[90dvh] w-full flex-col border border-line-default bg-raised shadow-e2',
          // A bottom sheet on a phone and a centred card from `sm` up — the
          // pattern the source panel already uses at this breakpoint.
          'rounded-t-xl sm:rounded-xl',
          size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-h3 text-primary">
              {title}
            </h2>
            {description !== undefined && (
              <p id={descriptionId} className="mt-1 text-body-sm text-secondary text-pretty">
                {description}
              </p>
            )}
          </div>

          <IconButton ref={closeRef} label="Close" onClick={onClose} className="-mr-1 shrink-0">
            <X className="size-[1.125rem]" strokeWidth={1.5} aria-hidden="true" />
          </IconButton>
        </div>

        <div className="scroll-region min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer !== undefined && (
          // `pb-safe` clears the iOS home indicator, which the sheet form of
          // this dialog sits directly on top of.
          <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 pt-4 pb-safe">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
