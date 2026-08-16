import { useMemo } from 'react';
import type { StreamPhase } from '@lumora/shared';
import { cn } from '@/lib/utils/cn';
import { Markdown } from './Markdown';

/**
 * Splits a partial answer into the part that is safe to render as markdown and
 * the trailing part that is not yet.
 *
 * docs/00-product.md §8.3 names this as one of streaming's two hard problems:
 * *"Incomplete markdown mid-stream (an unterminated code fence renders as
 * garbage): parse into a stable AST and render only complete block nodes; hold
 * the trailing incomplete block as plain text until it closes. Prevents visible
 * flicker and layout thrash."*
 *
 * The split is done on block boundaries rather than with a parser, and that is
 * a deliberate simplification: the property that matters is that a *fence* is
 * never handed to the renderer half-open, because that is the construct whose
 * partial form renders as garbage rather than as slightly-wrong prose. An
 * unterminated `**bold` renders as the literal asterisks and settles the
 * moment the closer arrives — annoying for one frame, not garbage. An
 * unterminated fence swallows the rest of the answer into a code block and
 * makes the layout jump when it finally closes.
 */
export function splitStreamingMarkdown(text: string): { stable: string; pending: string } {
  const fences = countFences(text);

  // Even number of fences: every block is closed, so all of it is safe.
  if (!fences.open) return { stable: text, pending: '' };

  return {
    stable: text.slice(0, fences.lastFenceIndex),
    // Held as plain text until the closing fence arrives.
    pending: text.slice(fences.lastFenceIndex),
  };
}

/**
 * Finds whether a fence is open, and where the open one started.
 *
 * Counts ``` and ~~~ at the start of a line. An odd count means the last one is
 * still open.
 */
function countFences(text: string): { open: boolean; lastFenceIndex: number } {
  const pattern = /^(?:```|~~~)/gm;
  let count = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    count += 1;
    lastIndex = match.index;
  }

  return { open: count % 2 === 1, lastFenceIndex: lastIndex };
}

interface StreamingMessageProps {
  text: string;
  phase: StreamPhase | null;
  sourceCount: number;
  streaming: boolean;
}

/**
 * The assistant turn while it is still being written.
 *
 * Separate from `MessageBubble` because the two have genuinely different jobs:
 * this one renders a moving target and a cursor, that one renders a finished
 * answer with actions. Merging them would put `streaming &&` in front of half
 * the markup.
 */
export function StreamingMessage({ text, phase, sourceCount, streaming }: StreamingMessageProps) {
  const { stable, pending } = useMemo(() => splitStreamingMarkdown(text), [text]);

  if (text.length === 0) {
    return <StatusIndicator phase={phase} sourceCount={sourceCount} />;
  }

  return (
    <article className="space-y-3">
      <div className="text-body-sm leading-relaxed text-primary">
        {stable.length > 0 && <Markdown>{stable}</Markdown>}

        {/*
          The unterminated tail, as plain text. `whitespace-pre-wrap` keeps the
          shape of a half-written code block readable instead of collapsing it
          into a paragraph.
        */}
        {pending.length > 0 && (
          <p className="whitespace-pre-wrap break-words font-mono text-caption text-secondary">
            {pending}
          </p>
        )}

        {streaming && <Cursor />}
      </div>
    </article>
  );
}

/**
 * The block cursor that marks a live stream.
 *
 * Rendered inline after the text rather than as a separate row, so it sits at
 * the end of the sentence being written — a cursor on its own line reads as a
 * new empty paragraph and makes the layout jump on every token.
 */
function Cursor() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[1em] w-[0.5ch] translate-y-[0.15em] animate-pulse bg-primary align-baseline motion-reduce:animate-none"
    />
  );
}

/**
 * What the server says it is doing, before the first token.
 *
 * docs/00-product.md §8.3: *"`Searching your documents` → `Reading 5 passages`
 * → first token arrives → indicator is replaced by text. These are real phases
 * reported by the server over the stream, not fake theatre — showing a spinner
 * labeled with something that is not happening is a trust leak."*
 */
function StatusIndicator({
  phase,
  sourceCount,
}: {
  phase: StreamPhase | null;
  sourceCount: number;
}) {
  const label =
    phase === 'generating'
      ? sourceCount > 0
        ? `Reading ${String(sourceCount)} ${sourceCount === 1 ? 'passage' : 'passages'}`
        : 'Writing an answer'
      : 'Searching your documents';

  return (
    <p
      className="flex items-center gap-2 text-body-sm text-secondary"
      // Announced once when it changes, rather than on every token.
      aria-live="polite"
    >
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className={cn(
              'size-1.5 rounded-full bg-tertiary',
              'animate-pulse motion-reduce:animate-none',
            )}
            style={{ animationDelay: `${String(dot * 150)}ms` }}
          />
        ))}
      </span>
      {label}
    </p>
  );
}
