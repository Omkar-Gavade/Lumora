import { FileText, Plus, Search, SendHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * The hero asset is a pixel-accurate static build of the real chat surface,
 * not a stock illustration or a video. If the product is good, showing it is
 * the strongest available claim — and unlike an image it stays sharp at every
 * density and inverts correctly in dark mode.
 *
 * Content is deliberately concrete: a real contract question with a real
 * citation. Lorem-ipsum here would undercut the entire pitch.
 */

const CONVERSATIONS = [
  { label: 'Termination & notice periods', active: true },
  { label: 'Payment terms comparison', active: false },
  { label: 'Data processing obligations', active: false },
];

const SOURCES = [
  { index: 1, document: 'Vendor-Agreement-2026.pdf', locator: 'p. 12 · §8.2 Termination' },
  { index: 2, document: 'Vendor-Agreement-2026.pdf', locator: 'p. 13 · §8.4 Cure period' },
];

function Citation({ index }: { index: number }) {
  return (
    <span
      className={cn(
        // Left margin only: a right margin pushes the following punctuation
        // away from the marker, leaving "notice [1] ." on the line.
        'ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] px-1',
        'bg-accent-subtle align-super text-[0.5625rem] font-semibold text-accent',
      )}
    >
      {index}
    </span>
  );
}

export function ProductPreview() {
  return (
    <div
      // Presentational: the real interface lives behind auth. Hidden from the
      // a11y tree and replaced with a description, so a screen reader gets the
      // meaning instead of a maze of fake chrome.
      role="img"
      aria-label="The Lumora chat interface answering a question about a vendor agreement, with two inline citations linking to specific pages of the source PDF."
      className={cn(
        'overflow-hidden rounded-xl border border-line bg-raised shadow-e2',
        'select-none',
      )}
    >
      {/* Window chrome — a single slim bar with the active knowledge base,
          rather than fake traffic lights. */}
      <div className="flex h-11 items-center gap-3 border-b border-line bg-subtle px-4">
        {/* Dots are decoration and are the first thing to go when width is
            scarce — below sm the meta label takes the full bar instead of
            wrapping onto two lines behind them. */}
        <div className="hidden items-center gap-1.5 sm:flex" aria-hidden="true">
          <span className="size-2 rounded-full bg-line-strong" />
          <span className="size-2 rounded-full bg-line-strong" />
          <span className="size-2 rounded-full bg-line-strong" />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-caption text-tertiary sm:mx-auto">
          <FileText className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="tabular truncate">4 documents · 1,182 passages indexed</span>
        </div>
      </div>

      <div className="flex" aria-hidden="true">
        {/* Sidebar */}
        <aside className="hidden w-52 shrink-0 flex-col gap-4 border-r border-line bg-subtle/60 p-3 sm:flex">
          <div className="flex h-8 items-center gap-2 rounded-md border border-line-default bg-raised px-2.5 text-caption text-secondary">
            <Plus className="size-3.5" />
            New chat
          </div>
          <div className="flex h-8 items-center gap-2 rounded-md px-2.5 text-caption text-tertiary">
            <Search className="size-3.5" />
            Search
          </div>

          <div>
            <p className="px-2.5 pb-2 text-micro font-medium tracking-[0.08em] text-tertiary uppercase">
              Today
            </p>
            <ul className="space-y-0.5">
              {CONVERSATIONS.map((conversation) => (
                <li
                  key={conversation.label}
                  className={cn(
                    'truncate rounded-md px-2.5 py-1.5 text-caption',
                    conversation.active
                      ? 'bg-active text-primary'
                      : 'text-secondary',
                  )}
                >
                  {conversation.label}
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* Thread */}
        <div className="min-w-0 flex-1 p-5 sm:p-7">
          <div className="flex justify-end">
            <p className="max-w-[85%] rounded-xl rounded-br-sm bg-inset px-3.5 py-2.5 text-body-sm text-primary">
              What&rsquo;s the notice period for terminating this agreement?
            </p>
          </div>

          <div className="mt-6">
            <p className="mb-2.5 text-micro font-medium tracking-[0.08em] text-tertiary uppercase">
              Lumora
            </p>
            <div className="space-y-3 text-body-sm text-primary">
              <p>
                Either party may terminate for convenience with{' '}
                <strong className="font-semibold">30 days&rsquo; written notice</strong> to the
                address listed in Schedule A<Citation index={1} />.
              </p>
              <p>
                Termination for material breach is separate: the non-breaching party must give
                written notice and allow a{' '}
                <strong className="font-semibold">15-day cure period</strong> before the
                termination takes effect<Citation index={2} />.
              </p>
            </div>

            {/* Sources — rendered before the answer finishes streaming in the
                real product, which removes the perceived stall. */}
            <div className="mt-5 rounded-lg border border-line bg-subtle/60 p-3">
              <p className="mb-2.5 text-micro font-medium tracking-[0.08em] text-tertiary uppercase">
                Sources
              </p>
              <ul className="space-y-2">
                {SOURCES.map((source) => (
                  <li key={source.index} className="flex items-start gap-2.5">
                    <span className="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-accent-subtle text-[0.5625rem] font-semibold text-accent">
                      {source.index}
                    </span>
                    <span className="min-w-0 text-caption">
                      <span className="block truncate text-primary">{source.document}</span>
                      <span className="block truncate text-tertiary">{source.locator}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Composer */}
          <div className="mt-6 flex h-11 items-center gap-3 rounded-xl border border-line-default bg-raised px-3.5">
            <span className="flex-1 truncate text-body-sm text-tertiary">
              Ask a follow-up…
            </span>
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-ink-solid text-on-ink">
              <SendHorizontal className="size-3.5" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
