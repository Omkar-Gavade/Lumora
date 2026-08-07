import { z } from 'zod';

/**
 * These schemas will move to the shared workspace once the backend exists, so
 * one definition drives both client-side form validation and server-side
 * request validation. Keeping the shapes here now means that move is a file
 * relocation rather than a rewrite. See docs/02-frontend.md §3.
 */

export const PASSWORD_MIN_LENGTH = 12;

const email = z
  .string()
  .min(1, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .pipe(z.email('That doesn’t look like a valid email address.'));

/** Sign-in is intentionally lenient: rejecting a short password at the login
 *  form tells an attacker the rules and tells a legitimate user nothing. */
const currentPassword = z.string().min(1, 'Enter your password.');

const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(128, 'Use fewer than 128 characters.')
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value), {
    message: 'Include both uppercase and lowercase letters.',
  })
  .refine((value) => /\d/.test(value), { message: 'Include at least one number.' });

export const loginSchema = z.object({
  email,
  password: currentPassword,
  remember: z.boolean(),
});

export const signupSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Enter your name.')
      .max(80, 'That name is too long.'),
    email,
    password: newPassword,
    confirmPassword: z.string().min(1, 'Re-enter your password.'),
    acceptTerms: z.literal(true, { message: 'Please accept the terms to continue.' }),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Passwords don’t match.',
    // Attach to the field the user must fix, not to the form root.
    path: ['confirmPassword'],
  });

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({
    password: newPassword,
    confirmPassword: z.string().min(1, 'Re-enter your password.'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Passwords don’t match.',
    path: ['confirmPassword'],
  });

export type LoginValues = z.infer<typeof loginSchema>;
export type SignupValues = z.infer<typeof signupSchema>;
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

export interface PasswordRule {
  label: string;
  test: (value: string) => boolean;
}

/**
 * Shown before the user types rather than as post-hoc errors. A checklist that
 * ticks as it is satisfied turns password entry from a guessing game into a
 * task with visible progress.
 */
export const PASSWORD_RULES: PasswordRule[] = [
  { label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (v) => v.length >= PASSWORD_MIN_LENGTH },
  { label: 'Upper and lowercase letters', test: (v) => /[a-z]/.test(v) && /[A-Z]/.test(v) },
  { label: 'At least one number', test: (v) => /\d/.test(v) },
];
