/**
 * Sanitizes a `?next=` destination before it is used for navigation.
 *
 * `next` is attacker-supplied — anyone can mail a link to
 * `/login?next=https://evil.example` — so an unchecked value is a textbook
 * open redirect: the user signs in on the real site and is then handed to a
 * page that can convincingly ask for the password again.
 *
 * A `startsWith('/')` check is the obvious guard and is **not sufficient**:
 * `//evil.example` also starts with a slash and is a protocol-relative URL
 * that browsers resolve to a different origin entirely. `/\` is treated the
 * same way by some browsers. Both are rejected here.
 */
export function safeNextPath(next: string | null, fallback: string): string {
  if (!next) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
