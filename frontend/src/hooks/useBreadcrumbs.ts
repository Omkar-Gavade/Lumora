import { useLocation } from 'react-router-dom';
import { ROUTES } from '@/app/router/routes';

export interface Crumb {
  label: string;
  /** Absent on the final crumb — the page you are already on is not a link. */
  to?: string;
}

/**
 * Segment → label. Anything not listed falls back to a title-cased segment,
 * so a route added before its label is registered degrades to "Api Keys"
 * rather than to a blank crumb.
 */
const SEGMENT_LABELS: Record<string, string> = {
  chat: 'Chat',
  knowledge: 'Knowledge Base',
  documents: 'Documents',
  settings: 'Settings',
  profile: 'Profile',
  security: 'Security',
  appearance: 'Appearance',
};

function titleCase(segment: string): string {
  return segment
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Breadcrumbs derived from the URL, not declared by pages.
 *
 * A page that announces its own trail has to be kept in sync with the route
 * tree by hand, and the two drift the first time a route moves. The URL is
 * already the authoritative statement of where the user is; reading it means
 * a deep link, a browser back, and a click through the nav all produce the
 * same trail without any page participating.
 *
 * The `/app` prefix is dropped. It is a routing artifact, not a place —
 * showing it would put a crumb in every trail that leads nowhere the user
 * would ever want to go.
 */
export function useBreadcrumbs(): Crumb[] {
  const { pathname } = useLocation();

  const segments = pathname
    .replace(ROUTES.app, '')
    .split('/')
    .filter(Boolean);

  return segments.map((segment, index) => {
    const isLast = index === segments.length - 1;
    const label = SEGMENT_LABELS[segment] ?? titleCase(segment);
    if (isLast) return { label };
    return { label, to: `${ROUTES.app}/${segments.slice(0, index + 1).join('/')}` };
  });
}
