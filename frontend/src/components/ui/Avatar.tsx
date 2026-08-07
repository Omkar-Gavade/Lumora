import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

const avatar = cva(
  [
    'relative grid shrink-0 place-items-center overflow-hidden rounded-full',
    'bg-inset font-medium text-secondary select-none',
  ],
  {
    variants: {
      size: {
        sm: 'size-6 text-micro',
        md: 'size-7 text-caption',
        lg: 'size-9 text-body-sm',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

interface AvatarProps extends VariantProps<typeof avatar> {
  name: string;
  src?: string | undefined;
  className?: string;
}

/**
 * First letter of the first two words, capped at two characters — "Omkar
 * Gavade" gives OG, "Omkar" gives O. Deliberately not `name.slice(0, 2)`,
 * which produces "Om" and reads as a truncated word rather than a monogram.
 */
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

/**
 * No colored auto-generated backgrounds. A hash-to-hue avatar sprays six
 * unrelated saturated circles across a UI whose entire premise is one accent
 * used rarely — it is the most common way a restrained palette gets ruined by
 * a component nobody reviewed.
 */
export function Avatar({ name, src, size, className }: AvatarProps) {
  return (
    <span className={cn(avatar({ size }), className)} aria-hidden="true">
      {src ? (
        <img src={src} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        initials(name)
      )}
    </span>
  );
}
