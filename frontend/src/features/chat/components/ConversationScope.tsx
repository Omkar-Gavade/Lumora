import { Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { buildRoute } from '@/app/router/routes';
import { useKnowledgeBases } from '@/features/knowledge/hooks/useKnowledgeBases';

interface ConversationScopeProps {
  knowledgeBaseId: string | null | undefined;
}

/**
 * Names the knowledge base a conversation is answering from
 * (docs/07-knowledge-base.md §4.5).
 *
 * Renders nothing for an unscoped conversation. That is deliberate: the
 * absence of a claim, rather than a claim of absence. A permanent "Searching
 * all documents" bar would put a row of chrome above every thread in the
 * product to state the default.
 *
 * The scope is not editable here. It is chosen when the chat starts and frozen
 * once the first message lands (§2.2), and the server enforces that — offering
 * a control that would be refused most of the time is worse than offering none.
 */
export function ConversationScope({ knowledgeBaseId }: ConversationScopeProps) {
  // The list is already cached by the sidebar and the knowledge page; reading
  // the name from it costs nothing rather than a request per conversation.
  const bases = useKnowledgeBases();

  if (knowledgeBaseId == null) return null;

  const base = bases.data?.items.find((item) => item.id === knowledgeBaseId);

  return (
    <div className="border-b border-line px-4 py-2 sm:px-6">
      <div className="mx-auto flex max-w-3xl items-center gap-2 text-caption text-tertiary">
        <BookOpen className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        <span className="shrink-0">Searching</span>

        {base === undefined ? (
          // The name has not arrived, or the base was deleted under the
          // conversation. Either way, saying nothing specific beats guessing.
          <span className="truncate text-secondary">this knowledge base</span>
        ) : (
          <Link
            to={buildRoute.knowledgeBase(base.id)}
            className="truncate font-medium text-secondary underline-offset-2 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {base.name}
          </Link>
        )}
      </div>
    </div>
  );
}
