import { z } from 'zod';
import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../constants/limits.js';

/**
 * The auth request contracts, written once and used on both sides
 * (docs/02-frontend.md §3).
 *
 * The backend validates requests with these; the frontend builds its form
 * schemas on top of them. A field renamed here is a compile error in both
 * applications rather than a runtime `undefined` in production.
 *
 * These describe the **API**, not the forms. `confirmPassword`, `acceptTerms`,
 * and "keep me signed in" are UI concerns layered on by the frontend — the
 * server has no use for a confirmation field, and validating one would invite
 * the client to send the password twice.
 */

/**
 * Lowercased and trimmed at the schema, so normalization cannot be forgotten
 * at a call site. The database column is `CITEXT`, which makes lookup
 * case-insensitive too — belt and braces, because one of the two is always the
 * one someone bypasses.
 */
export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address.')
  .max(EMAIL_MAX_LENGTH, 'That email address is too long.')
  .toLowerCase()
  .pipe(z.email('That doesn’t look like a valid email address.'));

/**
 * Rules for a password being *set*. Length first, because length is what
 * actually resists a modern cracking rig; the character-class rules are kept
 * modest so they nudge without pushing people toward `Password1!`.
 */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use fewer than ${String(PASSWORD_MAX_LENGTH)} characters.`)
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value), {
    message: 'Include both uppercase and lowercase letters.',
  })
  .refine((value) => /\d/.test(value), { message: 'Include at least one number.' });

/**
 * A password being *presented*. Only "not empty".
 *
 * Applying the full rules at sign-in would reject a legitimate password set
 * before the rules changed, and it would publish the current policy to anyone
 * probing the endpoint. Neither helps; both hurt.
 */
export const currentPasswordSchema = z.string().min(1, 'Enter your password.');

export const displayNameSchema = z
  .string()
  .trim()
  .min(DISPLAY_NAME_MIN_LENGTH, 'Enter your name.')
  .max(DISPLAY_NAME_MAX_LENGTH, 'That name is too long.');

/** Opaque single-use links from email. Bounded so a huge body cannot be probed. */
export const opaqueTokenSchema = z
  .string()
  .min(1, 'This link is missing its token.')
  .max(512, 'That token is not valid.');

export const signupRequestSchema = z.object({
  displayName: displayNameSchema,
  email: emailSchema,
  password: newPasswordSchema,
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: currentPasswordSchema,
  /**
   * Controls refresh-cookie persistence, not token lifetime: a session cookie
   * when false, a 30-day cookie when true. The refresh token's server-side
   * expiry is the same either way — this only decides whether closing the
   * browser ends the session.
   */
  remember: z.boolean().default(true),
});

export const forgotPasswordRequestSchema = z.object({ email: emailSchema });

export const resetPasswordRequestSchema = z.object({
  token: opaqueTokenSchema,
  password: newPasswordSchema,
});

export const verifyEmailRequestSchema = z.object({ token: opaqueTokenSchema });

export type SignupRequest = z.infer<typeof signupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

export interface PasswordRule {
  label: string;
  test: (value: string) => boolean;
}

/**
 * The same rules as `newPasswordSchema`, expressed as a checklist.
 *
 * Duplication with intent: the schema decides accept/reject, this drives a
 * live-ticking list shown *before* the user types (docs/00-product.md §8).
 * They are derived from the same constants, and a rule added to one without
 * the other is caught by the contract test that runs every rule against the
 * schema.
 */
export const PASSWORD_RULES: PasswordRule[] = [
  {
    label: `At least ${String(PASSWORD_MIN_LENGTH)} characters`,
    test: (value) => value.length >= PASSWORD_MIN_LENGTH,
  },
  {
    label: 'Upper and lowercase letters',
    test: (value) => /[a-z]/.test(value) && /[A-Z]/.test(value),
  },
  { label: 'At least one number', test: (value) => /\d/.test(value) },
];

/**
 * Account self-service bodies (docs/04-data-and-api.md §2.2).
 *
 * `currentPasswordSchema` for the credential being *proved* and
 * `newPasswordSchema` for the one being *set* — the asymmetry is deliberate and
 * explained above: applying the full policy to a password the user already has
 * would reject a legitimate account whose password predates the current rules.
 */
export const updateProfileRequestSchema = z.object({
  displayName: displayNameSchema,
});

export const changePasswordRequestSchema = z.object({
  currentPassword: currentPasswordSchema,
  newPassword: newPasswordSchema,
});

export const deleteAccountRequestSchema = z.object({
  password: currentPasswordSchema,
});

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;
