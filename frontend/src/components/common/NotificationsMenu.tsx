import { Bell } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Menu } from '@/components/ui/Menu';

/**
 * Notifications, with nothing in them.
 *
 * There is no dot on the bell. An unread indicator that is never earned is a
 * small lie the interface tells every time it loads, and it trains people to
 * ignore the one that eventually matters.
 *
 * The empty copy names what *will* arrive rather than only reporting absence,
 * so the control explains its own purpose before it has ever been used —
 * which, for a placeholder, is the entire job.
 */
export function NotificationsMenu() {
  const trigger = (
    <IconButton label="Notifications">
      <Bell className="size-[1.125rem]" strokeWidth={1.5} aria-hidden="true" />
    </IconButton>
  );

  return (
    <Menu trigger={trigger} label="Notifications" align="end" className="min-w-72">
      <div className="px-2.5 pt-2 pb-1">
        <p className="text-body-sm font-medium text-primary">Notifications</p>
      </div>

      <div className="px-2.5 pt-2 pb-3">
        <p className="text-body-sm text-secondary">You&rsquo;re all caught up</p>
        <p className="mt-1 text-caption text-tertiary text-pretty">
          Document processing updates and usage alerts will show up here.
        </p>
      </div>
    </Menu>
  );
}
