import type { UserDto } from '@lumora/shared';

/**
 * The user as the domain sees it.
 *
 * Distinct from both the database row and the API DTO, and that separation is
 * the point. The row is `snake_case` and carries `password_hash`; the DTO is
 * what a client may see. This sits between them so a service reasons about a
 * `User` without touching persistence naming or worrying about what is safe to
 * serialize.
 *
 * `passwordHash`, `tokenVersion`, and the lockout counters are present because
 * services genuinely need them — and are absent from `UserDto`, which is what
 * makes leaking one a compile error rather than a review catch.
 */
export interface User {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  emailVerifiedAt: Date | null;
  tokenVersion: number;
  failedLoginCount: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The authenticated caller, as attached to a request by `authenticate`.
 *
 * Built purely from JWT claims — no database row — which is what keeps the
 * access-token path free of a per-request query (docs/03-backend.md §3).
 */
export interface Actor {
  userId: string;
  email: string;
  emailVerified: boolean;
  tokenVersion: number;
}

/**
 * The single place a `User` becomes something a client may see.
 *
 * Every response funnels through here, so there is one line to audit for
 * accidental disclosure rather than one per endpoint.
 */
export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}
