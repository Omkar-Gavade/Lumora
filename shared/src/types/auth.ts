/**
 * The user as the API represents it.
 *
 * A deliberate projection of the `users` row, not the row itself. `password_hash`,
 * `token_version`, `failed_login_count`, and `locked_until` exist in the
 * database and must never reach a client — an explicit DTO makes that a
 * compile-time property rather than a review checklist item, because adding a
 * column no longer widens the response by default.
 *
 * `displayName`, not `name`: the column is `display_name` and the distinction
 * matters later, when a workspace has both a display name and a legal name.
 */
export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  /** FR-5 gates uploading and chat on this, not sign-in. */
  emailVerified: boolean;
  createdAt: string;
}

/**
 * What signup, login, and refresh return.
 *
 * The refresh token is **not** here — it travels only as an httpOnly cookie,
 * so JavaScript never sees it and an XSS cannot exfiltrate it
 * (docs/04-data-and-api.md §3.1).
 */
export interface AuthSessionDto {
  user: UserDto;
  /** JWT. Held in memory by the client, never in localStorage. */
  accessToken: string;
  /** Seconds until `accessToken` expires — lets a client refresh proactively. */
  expiresIn: number;
}
