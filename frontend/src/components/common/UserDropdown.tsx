import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Moon, Settings, Sun } from 'lucide-react';
import { ROUTES } from '@/app/router/routes';
import { useAuth, useAuthenticatedUser } from '@/app/providers/AuthProvider';
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
  const user = useAuthenticatedUser();
  const { signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  return (
    <Menu trigger={trigger} label="Account" side={side} align={align} className="min-w-60">
      <MenuHeader>
        <p className="truncate text-body-sm font-medium text-primary">{user.displayName}</p>
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

      {/* Navigation is explicit rather than left to the guard. `ProtectedRoute`
          would redirect on the next render anyway, but going through it means
          a frame of the app shell rendering with no user behind it. */}
      <MenuItem
        icon={LogOut}
        onSelect={() => {
          void signOut().then(() => navigate(ROUTES.login, { replace: true }));
        }}
        destructive
      >
        Sign out
      </MenuItem>
    </Menu>
  );
}
