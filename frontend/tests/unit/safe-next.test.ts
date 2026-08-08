import { describe, expect, it } from 'vitest';
import { safeNextPath } from '@/app/router/safe-next';

const FALLBACK = '/app/chat';

/**
 * Open-redirect prevention.
 *
 * `?next=` is attacker-supplied — anyone can mail a link to
 * `/login?next=https://evil.example`. An unchecked value means the user signs
 * in on the real site and is then handed to a page that can convincingly ask
 * for the password again.
 */
describe('safeNextPath', () => {
  it('accepts an ordinary in-app path', () => {
    expect(safeNextPath('/app/documents', FALLBACK)).toBe('/app/documents');
    expect(safeNextPath('/app/chat/abc?x=1', FALLBACK)).toBe('/app/chat/abc?x=1');
  });

  it('falls back when there is no destination', () => {
    expect(safeNextPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath('', FALLBACK)).toBe(FALLBACK);
  });

  it.each([
    ['an absolute https URL', 'https://evil.example'],
    ['an absolute http URL', 'http://evil.example/login'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a bare host', 'evil.example'],
  ])('rejects %s', (_label, next) => {
    expect(safeNextPath(next, FALLBACK)).toBe(FALLBACK);
  });

  it.each([
    ['a protocol-relative URL', '//evil.example'],
    ['a protocol-relative URL with a path', '//evil.example/login'],
    ['a backslash-escaped host', '/\\evil.example'],
  ])('rejects %s — the case a startsWith("/") check misses', (_label, next) => {
    /*
      This is the trap. `//evil.example` starts with a slash and passes the
      obvious guard, but browsers resolve it against the current scheme and
      navigate to a different origin entirely. `/\` is treated the same way by
      several browsers.
    */
    expect(safeNextPath(next, FALLBACK)).toBe(FALLBACK);
  });
});
