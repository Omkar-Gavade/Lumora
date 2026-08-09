import { useState } from 'react';
import { AlertCircle, FileText, RotateCcw } from 'lucide-react';
import type { MessageDto, TurnSourceDto } from '@lumora/shared';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/Button';
import { CopyButton, Markdown } from './Markdown';

interface MessageBubbleProps {
  message: MessageDto;
  /** Sources for this turn, when it is the one just answered. */
  sources?: TurnSourceDto[] | undefined;
  onRetry?: (() => void) | undefined;
  retrying?: boolean | undefined;
  onOpenSource?: ((chunkId: string) => void) | undefined;
}

/**
 * One turn in the thread.
 *
 * A user message and an assistant answer are drawn differently on purpose: the
 * question is a compact right-aligned bubble, the answer is full-width prose.
 * A grounded answer with citations, code, and a source list is a document, and
 * boxing it in a chat bubble would make it narrower than it needs to be for no
 * reason other than symmetry.
 */
export function MessageBubble({
  message,
  sources,
  onRetry,
  retrying,
  onOpenSource,
}: MessageBubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-inset px-3.5 py-2.5 text-body-sm text-primary">
          {/*
            Rendered as plain text, not markdown. A user's question is not
            authored content, and interpreting their asterisks as emphasis
            silently changes what they typed.
          */}
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  if (message.status === 'failed') {
    return <FailedMessage onRetry={onRetry} retrying={retrying} />;
  }

  return (
    <article className="group space-y-3">
      <Markdown>{message.content}</Markdown>

      {sources !== undefined && sources.length > 0 && (
        <SourceList sources={sources} cited={message.citations.map((c) => c.citationIndex)} onOpen={onOpenSource} />
      )}

      {/*
        Actions appear on hover and on focus. `focus-within` is what keeps them
        reachable by keyboard — a hover-only affordance is invisible to anyone
        not using a mouse.
      */}
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <CopyButton text={message.content} label="Copy answer" />
        {onRetry !== undefined && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="inline-flex cursor-pointer items-center gap-1 rounded-xs px-1.5 py-0.5 text-caption text-tertiary transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed"
          >
            <RotateCcw className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * The failure state, inline in the thread.
 *
 * Inline rather than a toast: the failure belongs to this turn, and a
 * disappearing notification leaves a thread with a question and nothing under
 * it. The retry sits next to the thing it retries.
 */
function FailedMessage({
  onRetry,
  retrying,
}: {
  onRetry?: (() => void) | undefined;
  retrying?: boolean | undefined;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger/5 px-3.5 py-3">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-body-sm text-danger">That answer could not be generated.</p>
        <p className="mt-0.5 text-caption text-secondary">
          The model provider did not respond. Your question is still here — try again.
        </p>
      </div>
      {onRetry !== undefined && (
        <Button variant="secondary" size="sm" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </div>
  );
}

/**
 * The evidence behind an answer.
 *
 * Shows **every** source that reached the prompt, marking which the answer
 * actually cited. That distinction is the honest one: a list of only the cited
 * passages hides what the model considered and rejected, which is exactly what
 * someone checking a suspicious answer wants to see.
 */
function SourceList({
  sources,
  cited,
  onOpen,
}: {
  sources: TurnSourceDto[];
  cited: number[];
  onOpen?: ((chunkId: string) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const citedSet = new Set(cited);

  return (
    <div className="rounded-md border border-line">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-caption text-secondary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span>
          {cited.length} of {sources.length} {sources.length === 1 ? 'source' : 'sources'} cited
        </span>
        <span className="text-tertiary">{expanded ? 'Hide' : 'Show'}</span>
      </button>

      {expanded && (
        <ul className="border-t border-line">
          {sources.map((source) => (
            <li key={source.chunkId} className="border-b border-line last:border-b-0">
              <button
                type="button"
                onClick={() => onOpen?.(source.chunkId)}
                className={cn(
                  'flex w-full cursor-pointer gap-2.5 px-3 py-2.5 text-left hover:bg-hover',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-xs text-caption tabular',
                    citedSet.has(source.index)
                      ? 'bg-accent-subtle text-primary'
                      : 'bg-inset text-tertiary',
                  )}
                >
                  {source.index}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-caption font-medium text-primary">
                    <FileText className="size-3 shrink-0 text-tertiary" strokeWidth={1.5} aria-hidden="true" />
                    <span className="truncate">{source.documentTitle}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-caption text-tertiary">
                    {source.pageNumber !== null && <>Page {source.pageNumber}</>}
                    {source.pageNumber !== null && source.sectionPath !== null && <> · </>}
                    {source.sectionPath}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-caption text-secondary">
                    {source.text}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
