import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useTheme } from '@/app/providers/ThemeProvider';

/**
 * Two-state toggle rather than a light/dark/system menu: a dropdown here costs
 * a click and a popover for a decision most people make once. Choosing
 * explicitly pins the preference; untouched, it follows the OS.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={cn(
        'grid size-9 cursor-pointer place-items-center rounded-md text-secondary',
        'transition-colors duration-150 ease-[var(--ease-standard)]',
        'hover:bg-hover hover:text-primary',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
    >
      {theme === 'dark' ? (
        <Sun className="size-[1.125rem]" aria-hidden="true" />
      ) : (
        <Moon className="size-[1.125rem]" aria-hidden="true" />
      )}
    </button>
  );
}
