import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export interface AccordionItem {
  question: string;
  answer: ReactNode;
}

/**
 * Single-open accordion following the WAI-ARIA disclosure pattern.
 *
 * Two details that are usually missed and both matter:
 *  - Arrow/Home/End move between headers. Without it, a keyboard user has to
 *    tab through every open panel's content to reach the next question.
 *  - The panel stays mounted and is hidden with `grid-template-rows`, so
 *    in-page search still finds the answers and the height transition needs no
 *    measurement pass.
 */
export function Accordion({ items }: { items: AccordionItem[] }) {
  const baseId = useId();
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const headerRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = items.length - 1;
    let nextIndex: number | null = null;

    if (event.key === 'ArrowDown') nextIndex = index === lastIndex ? 0 : index + 1;
    else if (event.key === 'ArrowUp') nextIndex = index === 0 ? lastIndex : index - 1;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = lastIndex;

    if (nextIndex === null) return;
    event.preventDefault();
    headerRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="divide-y divide-[var(--border-subtle)] border-y border-line">
      {items.map((item, index) => {
        const isOpen = openIndex === index;
        const headerId = `${baseId}-header-${index}`;
        const panelId = `${baseId}-panel-${index}`;

        return (
          <div key={item.question}>
            <h3>
              <button
                ref={(node) => {
                  headerRefs.current[index] = node;
                }}
                id={headerId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenIndex(isOpen ? null : index)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(
                  'group flex w-full cursor-pointer items-start justify-between gap-6',
                  'py-5 text-left font-sans text-body font-medium tracking-normal text-primary',
                  'transition-colors duration-150 hover:text-secondary',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                )}
              >
                <span className="text-pretty">{item.question}</span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 grid size-5 shrink-0 place-items-center text-tertiary',
                    'transition-transform duration-300 ease-[var(--ease-standard)]',
                    isOpen && 'rotate-45',
                  )}
                >
                  <Plus className="size-4" />
                </span>
              </button>
            </h3>

            <div
              id={panelId}
              role="region"
              aria-labelledby={headerId}
              className={cn(
                'grid transition-[grid-template-rows] duration-300 ease-[var(--ease-standard)]',
                isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
              )}
            >
              <div className="overflow-hidden">
                <div
                  className={cn(
                    'max-w-2xl pb-6 text-body-sm text-secondary text-pretty',
                    'transition-opacity duration-200',
                    isOpen ? 'opacity-100' : 'opacity-0',
                  )}
                >
                  {item.answer}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
