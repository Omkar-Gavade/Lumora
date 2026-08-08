import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useAuthenticatedUser } from '@/app/providers/AuthProvider';
import { formatBytesOf } from '@/lib/utils/format';
import { PLACEHOLDER_USAGE } from '@/features/usage/placeholder-usage';
import { Avatar } from '@/components/ui/Avatar';
import { Meter } from '@/components/ui/Meter';
import { UserDropdown } from '@/components/common/UserDropdown';

/**
 * The bottom zone: how much room is left, and who you are.
 *
 * Storage sits *above* the account row rather than inside the menu because it
 * is the one number in this product that changes the user's behavior before
 * they act — a person about to upload a 200MB deposition should not have to
 * open a menu to learn there is no room. It is placed at the bottom, though,
 * not the top: it is reference information, checked occasionally, and the top
 * of a navigation panel belongs to navigation.
 *
 * Collapsed, the meter is dropped entirely instead of being squeezed into a
 * 40px stub. A bar with no label and no number is a decoration of a fact, not
 * the fact — and the number is the whole point.
 */
export function SidebarAccount({ collapsed }: { collapsed: boolean }) {
  const user = useAuthenticatedUser();
  // Real usage arrives with `GET /users/me/usage` in M3.
  const { usedBytes, limitBytes, documentCount } = PLACEHOLDER_USAGE;
  const ratio = limitBytes > 0 ? usedBytes / limitBytes : 0;

  const accountButton = (
    <button
      type="button"
      className={cn(
        'group flex w-full cursor-pointer items-center rounded-md border border-transparent',
        'transition-colors duration-150 ease-[var(--ease-standard)]',
        'hover:bg-sidebar-hover',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        collapsed ? 'mx-auto size-10 justify-center' : 'h-12 gap-2.5 px-2',
      )}
    >
      <Avatar name={user.displayName} size={collapsed ? 'md' : 'lg'} />

      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-body-sm font-medium text-primary">
              {user.displayName}
            </span>
            {/* The email, not a plan. `plan` was invented by the M0 mock and has
                no column behind it — billing is out of scope (docs/06 §2) — so
                showing the address is both real data and better identification
                when several accounts are in play. */}
            <span className="block truncate text-caption text-tertiary">{user.email}</span>
          </span>
          <ChevronsUpDown
            className="size-4 shrink-0 text-tertiary transition-colors group-hover:text-secondary"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </>
      )}

      <span className="sr-only">
        {collapsed ? `${user.displayName} — account menu` : 'Open account menu'}
      </span>
    </button>
  );

  return (
    <div className={cn('border-t border-line', collapsed ? 'px-3 py-3' : 'p-3')}>
      {!collapsed && (
        <div className="mb-3 px-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-caption font-medium text-secondary">Storage</span>
            <span className="text-caption text-tertiary tabular">
              {formatBytesOf(usedBytes, limitBytes)}
            </span>
          </div>

          <Meter
            value={ratio}
            label={`Storage used: ${formatBytesOf(usedBytes, limitBytes)}`}
            className="mt-2"
          />

          <p className="mt-2 text-caption text-tertiary">
            {documentCount} {documentCount === 1 ? 'document' : 'documents'} indexed
          </p>
        </div>
      )}

      {/* No tooltip on the collapsed avatar, unlike the nav rail above it.
          The nav icons need one because a glyph alone does not say "Knowledge
          Base"; an avatar opening a menu whose first line is the user's name
          and email explains itself the moment it is clicked. */}
      <UserDropdown trigger={accountButton} side="top" align="start" />
    </div>
  );
}
