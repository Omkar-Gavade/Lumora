import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/app/router/routes';
import { NAV_GROUPS } from '@/app/config/navigation';
import { LogoMark } from '@/components/common/Logo';
import { Tooltip } from '@/components/ui/Tooltip';
import { SidebarAccount } from './SidebarAccount';
import { SidebarEmptyState } from './SidebarEmptyState';
import { SidebarGroup } from './SidebarGroup';
import { SidebarItem } from './SidebarItem';

/**
 * Conversation history. Empty until the chat feature lands — the empty branch
 * is the state a new account is actually in, so it is the one worth designing.
 */
const RECENT_CONVERSATIONS: { id: string; title: string }[] = [];

/**
 * Everything inside the sidebar, independent of how the sidebar is mounted.
 *
 * The desktop panel and the mobile drawer render this same tree. That is the
 * whole reason the mobile navigation cannot drift from the desktop one: there
 * is no second implementation to forget to update.
 *
 * Three zones, top to bottom, separated by rules rather than by space at the
 * two places the eye needs a hard stop:
 *
 *   identity   56px, matching the header exactly, so the sidebar's bottom edge
 *              and the header's bottom edge form one unbroken line across the
 *              viewport. This is the single most load-bearing alignment in the
 *              shell and it is worth the fixed height it costs.
 *   navigation the only scrolling region, so a hundred conversations never
 *              push the account row off screen
 *   account    pinned, because "where am I over quota" and "how do I sign out"
 *              must never require a scroll
 */
export function SidebarContent({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* ── Identity ─────────────────────────────────────────────────────── */}
      <div
        className={cn(
          'flex h-[var(--app-header-h)] shrink-0 items-center border-b border-line',
          collapsed ? 'justify-center px-3' : 'px-4',
        )}
      >
        <Link
          to={ROUTES.chat}
          aria-label="Lumora — go to chat"
          className={cn(
            'inline-flex items-center gap-2.5 rounded-md',
            'transition-opacity duration-150 hover:opacity-70',
            'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring',
          )}
        >
          <LogoMark className="size-6 shrink-0 text-primary" />
          {!collapsed && (
            <span className="text-[1.0625rem] leading-none font-semibold tracking-[-0.02em] text-primary">
              Lumora
            </span>
          )}
        </Link>
      </div>

      {/* ── Navigation ───────────────────────────────────────────────────── */}
      <div className="scroll-region min-h-0 flex-1 overflow-y-auto px-3">
        {/*
          New chat is the product's primary verb, so it gets the first row and
          a surface of its own. It is a bordered raised control rather than a
          filled ink button: an ink block at the top of a panel this calm reads
          as an advertisement, and the sidebar has to be liveable for eight
          hours, not persuasive for eight seconds.
        */}
        <div className="pt-3">
          <Tooltip label="New chat" side="right" disabled={!collapsed}>
            <Link
              to={ROUTES.chat}
              className={cn(
                'group flex items-center rounded-md border border-line-default bg-raised',
                'text-body-sm font-medium text-primary shadow-e1',
                'transition-[background-color,border-color] duration-150 ease-[var(--ease-standard)]',
                'hover:border-line-strong hover:bg-hover',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                collapsed ? 'mx-auto size-10 justify-center' : 'h-11 gap-2 px-2.5 md:h-9',
              )}
            >
              <Plus className="size-4 shrink-0 text-secondary" strokeWidth={1.5} aria-hidden="true" />
              <span className={cn(collapsed && 'sr-only')}>New chat</span>
            </Link>
          </Tooltip>
        </div>

        <nav aria-label="Main" className="pt-6 pb-4">
          <div className="flex flex-col gap-6">
            {NAV_GROUPS.map((group) => (
              <SidebarGroup key={group.label ?? 'primary'} label={group.label} collapsed={collapsed}>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <SidebarItem
                      to={item.to}
                      label={item.label}
                      icon={item.icon}
                      collapsed={collapsed}
                      matchNested={item.matchNested ?? false}
                      badge={item.badge}
                    />
                  </li>
                ))}
              </SidebarGroup>
            ))}

            {/* The rail has no room for a list of titles, and a column of
                identical chat glyphs would carry no information at all. */}
            {!collapsed && (
              <SidebarGroup label="Recent" collapsed={false}>
                {RECENT_CONVERSATIONS.length === 0 ? (
                  <li>
                    <SidebarEmptyState
                      title="No conversations yet"
                      description="Ask something about your documents and it will appear here."
                    />
                  </li>
                ) : (
                  RECENT_CONVERSATIONS.map((conversation) => (
                    <li key={conversation.id}>{conversation.title}</li>
                  ))
                )}
              </SidebarGroup>
            )}
          </div>
        </nav>
      </div>

      {/* ── Account ──────────────────────────────────────────────────────── */}
      <SidebarAccount collapsed={collapsed} />
    </div>
  );
}
