import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge has to decide whether `text-<name>` is a font size or a text
 * color to know what conflicts with what. It cannot infer that for tokens that
 * only exist in our theme, so it guessed — and `text-body-sm` silently deleted
 * `text-on-ink` from every primary button, rendering white text on white.
 *
 * Registering both scales makes the classification explicit. Any new semantic
 * color or type-scale step must be added here as well.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      // Maps to Tailwind v4's `--color-*` namespace → the `text-color`,
      // `bg-color`, and `border-color` groups.
      color: [
        'canvas',
        'subtle',
        'raised',
        'inset',
        'hover',
        'active',
        'line',
        'line-default',
        'line-strong',
        'primary',
        'secondary',
        'tertiary',
        'inverse',
        'accent',
        'accent-hover',
        'accent-subtle',
        'success',
        'warning',
        'danger',
        'ink-solid',
        'ink-solid-hover',
        'on-ink',
        'ring',
      ],
      // Maps to the `--text-*` namespace → the `font-size` group.
      text: ['display', 'h1', 'h2', 'h3', 'body-lg', 'body', 'body-sm', 'caption', 'micro'],
    },
  },
});

/**
 * Merge class names so a later class always wins over an earlier conflicting
 * one. Without twMerge, `cn('px-4', props.className)` silently loses when the
 * caller passes `px-6` — both utilities land in the class list and CSS source
 * order decides, not the caller.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
