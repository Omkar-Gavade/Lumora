import { useLocation } from 'react-router-dom';
import { ROUTES } from '@/app/router/routes';
import { useConversations } from '@/features/chat/hooks/useChat';
import { useKnowledgeBases } from '@/features/knowledge/hooks/useKnowledgeBases';

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
 * A UUID is an identifier, never a label.
 *
 * Without this the trail on `/app/chat/01a00be8-a4fe-…` reads "Chat /
 * 01a00be8 A4fe 7a6b 8bf5 1617fd7bbc2e", because the generic fallback
 * title-cases whatever segment it is handed. On a phone that trail is the
 * only place the current conversation is named, so the failure is loudest
 * exactly where it matters most.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  /*
    The same query the sidebar already subscribes to, so resolving a title
    here is a cache read rather than a request — TanStack dedupes them by key.
    Reading the list rather than the conversation detail keeps this hook off
    the critical path of opening a thread.
  */
  const conversations = useConversations();
  const knowledgeBases = useKnowledgeBases();

  const segments = pathname
    .replace(ROUTES.app, '')
    .split('/')
    .filter(Boolean);

  return segments.map((segment, index) => {
    const isLast = index === segments.length - 1;

    let label = SEGMENT_LABELS[segment];
    if (label === undefined) {
      if (UUID_PATTERN.test(segment)) {
        // "Conversation" until the list arrives, and the real title after —
        // never the raw id. A generic word is a correct label; an id is not.
        // Whichever list the id belongs to. Both are already cached by the
        // sidebar and the knowledge page, so this is a read rather than a
        // request.
        label =
          conversations.data?.items.find((item) => item.id === segment)?.title ??
          knowledgeBases.data?.items.find((item) => item.id === segment)?.name ??
          'Conversation';
      } else {
        label = titleCase(segment);
      }
    }

    if (isLast) return { label };
    return { label, to: `${ROUTES.app}/${segments.slice(0, index + 1).join('/')}` };
  });
}
