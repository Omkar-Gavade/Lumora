import { useState } from 'react';
import { MessageSquare, Plus, Trash2 } from 'lucide-react';
import type { ConversationDto } from '@lumora/shared';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';

interface ConversationListProps {
  conversations: ConversationDto[];
  activeId: string | undefined;
  loading: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  busy: boolean;
}

/**
 * The thread list.
 *
 * Grouped by recency rather than shown as one flat list: a chat sidebar
 * accumulates, and "Today / This week / Earlier" is what lets someone find
 * yesterday's conversation without reading forty titles. The groups come from
 * `lastMessageAt`, which is when the thread was *used* — creation date would
 * sort a thread you returned to this morning under the day you started it.
 */
export function ConversationList({
  conversations,
  activeId,
  loading,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  busy,
}: ConversationListProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line p-3">
        <Button variant="secondary" size="sm" onClick={onCreate} disabled={busy} className="w-full">
          <Plus className="size-4" strokeWidth={1.5} aria-hidden="true" />
          New conversation
        </Button>
      </div>

      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="space-y-2 p-1" aria-busy="true">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-8 w-full" />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-caption text-tertiary">
            No conversations yet.
          </p>
        ) : (
          groupByRecency(conversations).map((group) => (
            <section key={group.label} className="mb-3 last:mb-0">
              <h3 className="px-2 pb-1 text-caption font-medium uppercase tracking-wide text-tertiary">
                {group.label}
              </h3>
              <ul>
                {group.items.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === activeId}
                    onSelect={onSelect}
                    onRename={onRename}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: ConversationDto;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const [confirming, setConfirming] = useState(false);

  if (renaming) {
    return (
      <li>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const title = draft.trim();
            if (title.length > 0 && title !== conversation.title) onRename(conversation.id, title);
            setRenaming(false);
          }}
          className="px-1 py-0.5"
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            // Escape cancels: a rename field with no way out but Enter forces
            // a commit the user may not want.
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(conversation.title);
                setRenaming(false);
              }
            }}
            onBlur={() => setRenaming(false)}
            /*
              Focused by ref rather than `autoFocus`.

              `autoFocus` on mount is an accessibility problem in general — it
              moves focus without the user asking. Here the user *did* ask, by
              activating rename, so focusing is correct; doing it through a ref
              expresses "focus this because it just appeared on request"
              instead of the blanket attribute the linter rightly bans.
            */
            ref={(element) => element?.focus()}
            aria-label="Conversation title"
            className="w-full rounded-xs border border-focus bg-surface px-2 py-1 text-caption text-primary outline-none"
          />
        </form>
      </li>
    );
  }

  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={() => onSelect(conversation.id)}
        onDoubleClick={() => setRenaming(true)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 pr-8 text-left',
          'text-caption transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
          active ? 'bg-inset text-primary' : 'text-secondary hover:bg-hover hover:text-primary',
        )}
      >
        <MessageSquare className="size-3.5 shrink-0 text-tertiary" strokeWidth={1.5} aria-hidden="true" />
        <span className="truncate">{conversation.title}</span>
      </button>

      {confirming ? (
        <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 bg-surface pl-1">
          <button
            type="button"
            onClick={() => {
              onDelete(conversation.id);
              setConfirming(false);
            }}
            className="cursor-pointer rounded-xs px-1 text-caption font-medium text-danger hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="cursor-pointer rounded-xs px-1 text-caption text-secondary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${conversation.title}`}
          // Hidden until hover or focus, so the row reads as a title rather
          // than as a toolbar — but never hidden from the keyboard.
          className="absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer rounded-xs p-1 text-tertiary opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover/row:opacity-100"
        >
          <Trash2 className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

interface Group {
  label: string;
  items: ConversationDto[];
}

/**
 * Buckets threads by when they were last used.
 *
 * Boundaries are calendar-relative, not elapsed-time: something from 11pm
 * yesterday belongs under "Yesterday" at 9am, not under "Today" because 10
 * hours have passed. Elapsed-time bucketing is the version of this that looks
 * right in a unit test and wrong to a person.
 */
export function groupByRecency(conversations: ConversationDto[], now = new Date()): Group[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

  const buckets: Group[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Earlier', items: [] },
  ];

  for (const conversation of conversations) {
    // A thread created but never used falls to `Earlier` rather than being
    // dropped — it is still in the list, and hiding it would be a bug the user
    // reports as "my conversation vanished".
    const at = conversation.lastMessageAt ?? conversation.createdAt;
    const time = new Date(at).getTime();

    if (time >= startOfToday) buckets[0]?.items.push(conversation);
    else if (time >= startOfYesterday) buckets[1]?.items.push(conversation);
    else if (time >= startOfWeek) buckets[2]?.items.push(conversation);
    else buckets[3]?.items.push(conversation);
  }

  return buckets.filter((bucket) => bucket.items.length > 0);
}
