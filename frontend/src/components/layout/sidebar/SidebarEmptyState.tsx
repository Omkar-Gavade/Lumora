import { cn } from '@/lib/utils/cn';

interface SidebarEmptyStateProps {
  title: string;
  description: string;
  className?: string;
}

/**
 * The empty state for a sidebar list.
 *
 * No icon, no dashed border, no "Get started" button. All three are the house
 * style of empty states that were designed to fill a hole rather than to say
 * something, and in a 264px panel each of them is louder than the navigation
 * it sits beneath.
 *
 * What is left is two lines: what is not here, and what will put something
 * here. The second line is the part that matters — an empty state that only
 * reports emptiness leaves the user to guess at the cause.
 */
export function SidebarEmptyState({ title, description, className }: SidebarEmptyStateProps) {
  return (
    <div className={cn('px-2.5 py-2', className)}>
      <p className="text-caption text-secondary">{title}</p>
      <p className="mt-1 text-caption text-tertiary text-pretty">{description}</p>
    </div>
  );
}
