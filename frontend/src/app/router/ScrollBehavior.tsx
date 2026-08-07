import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * A single-page app does not reset scroll on navigation the way a document
 * load does, so without this, moving from a scrolled homepage to /privacy
 * lands the reader halfway down the policy.
 *
 * Hash targets are left alone — the browser's own anchor handling plus
 * `scroll-padding-top` already places them correctly under the sticky header.
 */
export function ScrollBehavior() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) return;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname, hash]);

  return null;
}
