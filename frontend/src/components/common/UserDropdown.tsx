import type { ReactElement } from 'react';
import { LogOut, Moon, Settings, Sun } from 'lucide-react';
import { ROUTES } from '@/app/router/routes';
import { useSession } from '@/app/providers/SessionProvider';
import { useTheme } from '@/app/providers/ThemeProvider';
import { Menu, MenuHeader, MenuItem, MenuSeparator } from '@/components/ui/Menu';

interface UserDropdownProps {
  trigger: ReactElement;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
}

/**
 * The account menu — one component, two entry points.
 *
 * The header avatar and the sidebar account row open the *same* menu, because
 * they are the same question ("what can I do about my account?") asked from
 * two places the eye lands naturally: the top-right corner, and the bottom of
 * the navigation. Building them separately is how two menus drift into having
 * different items, which is a bug users report as "I can't find sign out".
 *
 * The theme row is here as well as in the header. That is not duplication for
 * its own sake: below `lg` the header sheds its theme toggle to keep the bar
 * from crowding, and this menu becomes the only way to change it.
 */
export function UserDropdown({ trigger, side = 'bottom', align = 'end' }: UserDropdownProps) {
  const { user, signOut } = useSession();
  const { theme, toggle } = useTheme();

  return (
    <Menu trigger={trigger} label="Account" side={side} align={align} className="min-w-60">
      <MenuHeader>
        <p className="truncate text-body-sm font-medium text-primary">{user.name}</p>
        <p className="mt-0.5 truncate text-caption text-tertiary">{user.email}</p>
      </MenuHeader>

      <MenuSeparator />

      <MenuItem icon={Settings} to={ROUTES.settings}>
        Settings
      </MenuItem>

      <MenuItem icon={theme === 'dark' ? Sun : Moon} onSelect={toggle}>
        {theme === 'dark' ? 'Light theme' : 'Dark theme'}
      </MenuItem>

      <MenuSeparator />

      <MenuItem icon={LogOut} onSelect={signOut} destructive>
        Sign out
      </MenuItem>
    </Menu>
  );
}
