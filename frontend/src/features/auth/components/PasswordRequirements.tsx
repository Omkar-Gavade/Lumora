import { Check } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { PASSWORD_RULES } from '../schemas/auth.schemas';

/**
 * The checklist is always visible, never conditional on an error. Requirements
 * revealed only after a failed submit are a quiz; requirements shown up front
 * are instructions.
 *
 * `aria-live="polite"` announces each rule as it is met, so a screen-reader
 * user gets the same progress feedback a sighted user gets from the ticks.
 */
export function PasswordRequirements({ value }: { value: string }) {
  const touched = value.length > 0;

  return (
    <ul className="mt-2.5 space-y-1.5" aria-live="polite">
      {PASSWORD_RULES.map((rule) => {
        const satisfied = rule.test(value);
        return (
          <li key={rule.label} className="flex items-center gap-2 text-caption">
            <span
              aria-hidden="true"
              className={cn(
                'grid size-3.5 shrink-0 place-items-center rounded-full border',
                'transition-colors duration-200 ease-[var(--ease-standard)]',
                satisfied
                  ? 'border-success bg-success text-white'
                  : 'border-line-strong bg-transparent',
              )}
            >
              {satisfied && <Check className="size-2.5 stroke-[3]" />}
            </span>
            <span
              className={cn(
                'transition-colors duration-200',
                satisfied ? 'text-secondary' : touched ? 'text-tertiary' : 'text-tertiary',
              )}
            >
              {rule.label}
            </span>
            <span className="sr-only">{satisfied ? '— met' : '— not yet met'}</span>
          </li>
        );
      })}
    </ul>
  );
}
