import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/app/router/routes';
import { NAV_GROUPS } from '@/app/config/navigation';
import { useSidebar } from '@/app/providers/SidebarProvider';
import { LogoMark } from '@/components/common/Logo';
import { Tooltip } from '@/components/ui/Tooltip';
import { SidebarAccount } from './SidebarAccount';
import { SidebarConversations } from './SidebarConversations';
import { SidebarGroup } from './SidebarGroup';
import { SidebarItem } from './SidebarItem';

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
  const { closeDrawer } = useSidebar();

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
              /*
                The drawer closes on navigation by deriving "open" from the
                route it was opened on — but starting a new chat *from* the
                new-chat route is not a navigation, so nothing changes and the
                drawer would stay open over an empty composer. Closing here
                covers the one case the derivation cannot see.
              */
              onClick={closeDrawer}
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

            <SidebarConversations collapsed={collapsed} />
          </div>
        </nav>
      </div>

      {/* ── Account ──────────────────────────────────────────────────────── */}
      <SidebarAccount collapsed={collapsed} />
    </div>
  );
}
