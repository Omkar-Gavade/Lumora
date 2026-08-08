import { Menu as MenuIcon, PanelLeft } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useSidebar } from '@/app/providers/SidebarProvider';
import { useAuthenticatedUser } from '@/app/providers/AuthProvider';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { Breadcrumbs } from '@/components/common/Breadcrumbs';
import { NotificationsMenu } from '@/components/common/NotificationsMenu';
import { SearchTrigger } from '@/components/common/SearchTrigger';
import { ThemeToggle } from '@/components/common/ThemeToggle';
import { UserDropdown } from '@/components/common/UserDropdown';

interface AppHeaderProps {
  onOpenPalette: () => void;
}

/**
 * 56px, one hairline, no shadow, no blur.
 *
 * The header's job is to be findable and then to stop being noticed. Every
 * choice here is subtractive: it is the same height as the sidebar's identity
 * row so their bottom borders form one line; it uses a solid canvas fill
 * rather than a translucent blur, because content scrolling *under* a frosted
 * bar is motion in the corner of the eye all day; and it carries no title of
 * its own, because the last breadcrumb already is one.
 *
 * The control cluster is ordered by how often it is used and how much damage a
 * mis-click does: search (constant, harmless) → notifications (occasional) →
 * theme (rare) → account (rare, and the only one that can sign you out). The
 * destructive-adjacent control is the furthest from the content.
 */
export function AppHeader({ onOpenPalette }: AppHeaderProps) {
  const { isMobile, collapsed, toggle } = useSidebar();
  const user = useAuthenticatedUser();

  const avatarButton = (
    <button
      type="button"
      aria-label="Account"
      className={cn(
        'grid size-9 shrink-0 cursor-pointer place-items-center rounded-md',
        'transition-colors duration-150 ease-[var(--ease-standard)] hover:bg-hover',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
    >
      <Avatar name={user.displayName} size="md" />
    </button>
  );

  return (
    <header
      className={cn(
        // Not `sticky`: the header is a sibling of the scroll region, not
        // inside it, so it is already immobile. `z-20` only orders it above
        // content that might otherwise paint over the hairline.
        'relative z-20 flex h-[var(--app-header-h)] shrink-0 items-center gap-2',
        'border-b border-line bg-canvas px-3 sm:px-4',
      )}
    >
      {/*
        One control, two meanings — because to the user they are one meaning.
        On a phone it opens the drawer; on a desktop it collapses the rail. The
        label changes with the state so a screen reader is never told to
        "toggle" something whose current position it cannot see.
      */}
      <IconButton
        label={isMobile ? 'Open navigation' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        onClick={toggle}
        aria-expanded={isMobile ? undefined : !collapsed}
      >
        {isMobile ? (
          <MenuIcon className="size-[1.125rem]" strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <PanelLeft className="size-[1.125rem]" strokeWidth={1.5} aria-hidden="true" />
        )}
      </IconButton>

      <Breadcrumbs className="flex-1 pl-1" />

      <div className="flex shrink-0 items-center gap-1">
        <SearchTrigger onOpen={onOpenPalette} />
        <NotificationsMenu />

        {/* Sheds below `lg`. The same switch lives in the account menu, which
            is always reachable — this is the copy that gets dropped when the
            bar runs out of room, not the capability. */}
        <ThemeToggle className="hidden lg:grid" />

        <UserDropdown trigger={avatarButton} align="end" />
      </div>
    </header>
  );
}
