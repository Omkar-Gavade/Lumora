import { z } from 'zod';
import {
  currentPasswordSchema,
  displayNameSchema,
  emailSchema,
  newPasswordSchema,
} from '@lumora/shared';

/**
 * Form schemas, built on the shared API contract.
 *
 * The primitives — email, password rules, name bounds — come from
 * `@lumora/shared` and are the *same objects* the backend validates with, so
 * the two cannot disagree about what a valid password is
 * (docs/02-frontend.md §3).
 *
 * What is added here is UI-only: `confirmPassword`, `acceptTerms`, and
 * "keep me signed in" exist for the person filling in the form, not for the
 * API. The server has no use for a confirmation field, and accepting one would
 * mean asking the client to transmit the password twice.
 */

export { PASSWORD_MIN_LENGTH, PASSWORD_RULES, type PasswordRule } from '@lumora/shared';

export const loginSchema = z.object({
  email: emailSchema,
  password: currentPasswordSchema,
  remember: z.boolean(),
});

export const signupSchema = z
  .object({
    name: displayNameSchema,
    email: emailSchema,
    password: newPasswordSchema,
    confirmPassword: z.string().min(1, 'Re-enter your password.'),
    acceptTerms: z.literal(true, { message: 'Please accept the terms to continue.' }),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Passwords don’t match.',
    // Attach to the field the user must fix, not to the form root.
    path: ['confirmPassword'],
  });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({
    password: newPasswordSchema,
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
