import { useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import type { ConversationDto } from '@lumora/shared';
import { cn } from '@/lib/utils/cn';
import { ROUTES, buildRoute } from '@/app/router/routes';
import { queryKeys } from '@/app/config/query-keys';
import { useSidebar } from '@/app/providers/SidebarProvider';
import { getConversation } from '@/features/chat/api/chat.api';
import { groupByRecency } from '@/features/chat/lib/recency';
import {
  useConversations,
  useDeleteConversation,
  useRenameConversation,
} from '@/features/chat/hooks/useChat';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { SidebarEmptyState } from './SidebarEmptyState';
import { SidebarGroup } from './SidebarGroup';

/**
 * Conversation history, in the primary navigation.
 *
 * docs/00-product.md FR-21 puts history in the sidebar, and this is that list.
 * It previously lived in a second column inside the chat page, hidden below
 * `lg` — which meant that on every phone and most tablets the product had no
 * conversation navigation at all, not a cramped one. Moving it here is what
 * makes the drawer the single navigation surface on mobile, and it costs
 * desktop nothing: the panel is the same width the column was.
 *
 * Grouping is `groupByRecency`, imported rather than reimplemented — the
 * buckets are a product decision (docs §7), and two copies of a date-bucketing
 * function is exactly how "Yesterday" starts meaning two different things in
 * two places.
 */
export function SidebarConversations({ collapsed }: { collapsed: boolean }) {
  const conversations = useConversations();

  /*
    The rail has no room for a list of titles, and a column of identical chat
    glyphs would carry no information at all — so the group is dropped rather
    than rendered as decoration. It returns the moment the panel expands.
  */
  if (collapsed) return null;

  const items = conversations.data?.items ?? [];

  return (
    <SidebarGroup label="Recent" collapsed={false}>
      {conversations.isPending ? (
        <li className="flex flex-col gap-1 px-2.5 py-1" aria-busy="true" aria-label="Loading conversations">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </li>
      ) : items.length === 0 ? (
        <li>
          <SidebarEmptyState
            title="No conversations yet"
            description="Ask something about your documents and it will appear here."
          />
        </li>
      ) : (
        groupByRecency(items).map((group) => (
          <li key={group.label}>
            {/*
              A day heading inside the Recent group, one step quieter than the
              group's own label. `text-micro` is already the smallest step, so
              the separation is carried by weight and case instead: the group
              label is uppercase and medium, the day is sentence case and
              regular. Two headings at the same volume would read as two
              groups.
            */}
            <h3 className="px-2.5 pt-3 pb-1 text-micro font-normal text-tertiary first:pt-0">
              {group.label}
            </h3>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((conversation) => (
                <ConversationRow key={conversation.id} conversation={conversation} />
              ))}
            </ul>
          </li>
        ))
      )}
    </SidebarGroup>
  );
}

/**
 * One conversation row.
 *
 * A `NavLink`, not a button: a conversation is a place with a URL, so it must
 * be middle-clickable, copyable, and reachable by the browser's own history.
 * The styling is `SidebarItem`'s, minus the icon — forty rows each carrying
 * the same speech-bubble glyph is forty pixels of noise per row and no
 * information, and the indent already says these are children of *Recent*.
 */
function ConversationRow({ conversation }: { conversation: ConversationDto }) {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { closeDrawer } = useSidebar();
  const rename = useRenameConversation();
  const remove = useDeleteConversation();

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);

  const active = conversation.id === conversationId;

  /*
    docs/02-frontend.md §4: "hovering a sidebar conversation calls
    prefetchQuery for its messages." A settled thread is immutable, so the
    prefetch is never wasted work on a second visit.
  */
  const prefetch = () => {
    void client.prefetchQuery({
      queryKey: queryKeys.conversations.detail(conversation.id),
      queryFn: () => getConversation(conversation.id),
    });
  };

  if (renaming) {
    const commit = () => {
      const title = draft.trim();
      if (title.length > 0 && title !== conversation.title) {
        rename.mutate({ id: conversation.id, title });
      }
      setRenaming(false);
    };

    return (
      <li>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
          className="flex items-center gap-1 px-1"
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Escape cancels: a rename field with no way out but Enter
              // forces a commit the user may not want.
              if (event.key === 'Escape') {
                setDraft(conversation.title);
                setRenaming(false);
              }
            }}
            /*
              Focused by ref rather than `autoFocus`. The user asked for this
              field by activating Rename, so focusing it is correct; a ref
              expresses "focus this because it just appeared on request"
              rather than the blanket attribute the linter rightly bans.
            */
            ref={(element) => element?.focus()}
            aria-label="Conversation title"
            className={cn(
              'h-11 min-w-0 flex-1 rounded-md border border-focus bg-surface px-2 md:h-9',
              'text-body-sm text-primary outline-none',
            )}
          />
          {/*
            Explicit commit and cancel controls rather than blur-to-save.
            On a phone there is no blur that is not also a tap on something
            else, and a rename that commits when you tap away is a rename you
            cannot abandon.
          */}
          <button
            type="submit"
            aria-label="Save title"
            className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-md text-secondary hover:bg-sidebar-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:size-9"
          >
            <Check className="size-4" strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Cancel rename"
            onClick={() => {
              setDraft(conversation.title);
              setRenaming(false);
            }}
            className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-md text-secondary hover:bg-sidebar-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:size-9"
          >
            <X className="size-4" strokeWidth={1.5} aria-hidden="true" />
          </button>
        </form>
      </li>
    );
  }

  return (
    <li className="group/row relative">
      <NavLink
        to={buildRoute.conversation(conversation.id)}
        onMouseEnter={prefetch}
        onFocus={prefetch}
        // Re-selecting the conversation you are already on is not a
        // navigation, so the drawer's route-derived "open" never flips. To a
        // thumb it was still a choice, and the drawer must get out of the way.
        onClick={closeDrawer}
        className={cn(
          'flex items-center rounded-md border border-transparent',
          'text-body-sm transition-[background-color,border-color,color] duration-150 ease-[var(--ease-standard)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          // 44px on touch, 36px once there is a pointer — the same pair
          // `SidebarItem` uses, because this is the same list to a thumb.
          'h-11 gap-2.5 px-2.5 md:h-9',
          // Room for the action button, which is absolutely positioned so it
          // cannot reflow the title when it appears. Wider on touch, where the
          // button itself is wider.
          'pr-11 md:pr-9',
          active
            ? 'border-line bg-sidebar-active font-medium text-primary shadow-e1'
            : 'text-secondary hover:bg-sidebar-hover hover:text-primary',
        )}
      >
        <span className="truncate">{conversation.title}</span>
      </NavLink>

      {/*
        Always in the DOM and always focusable; only its *opacity* is tied to
        hover. Hover-only actions are a real accessibility failure
        (docs/00-product.md §8.3) and on a touch screen there is no hover at
        all — so below `md` the trigger is simply always visible.
      */}
      <div
        className={cn(
          'absolute top-1/2 right-1 -translate-y-1/2',
          'md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:focus-within:opacity-100',
        )}
      >
        <Menu
          align="end"
          label={`${conversation.title} actions`}
          trigger={
            <button
              type="button"
              aria-label={`Actions for ${conversation.title}`}
              /*
                44px on touch (docs/01-design-system.md §6), 28px once there is
                a pointer. The glyph is the same size either way — the button
                carries no fill until hover, and there is no hover on a
                touchscreen, so the larger target is invisible and free.
              */
              className={cn(
                'grid size-11 cursor-pointer place-items-center rounded-md text-tertiary md:size-7',
                'hover:bg-hover hover:text-primary',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              )}
            >
              <MoreHorizontal className="size-4" strokeWidth={1.5} aria-hidden="true" />
            </button>
          }
        >
          <MenuItem
            icon={Pencil}
            onSelect={() => {
              setDraft(conversation.title);
              setRenaming(true);
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            icon={Trash2}
            destructive
            onSelect={() => {
              remove.mutate(conversation.id, {
                // Leaving the user on a thread that no longer exists would
                // show them a 404 for something they just deleted.
                onSuccess: () => {
                  if (active) void navigate(ROUTES.chat);
                },
              });
            }}
          >
            Delete
          </MenuItem>
        </Menu>
      </div>
    </li>
  );
}
