import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Plus } from 'lucide-react';
import type { KnowledgeBaseDto } from '@lumora/shared';
import { buildRoute } from '@/app/router/routes';
import { messageForError } from '@/constants/messages';
import { PageContainer } from '@/components/layout/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatRelativeTime } from '@/lib/utils/format';
import { KnowledgeBaseFormDialog } from '@/features/knowledge/components/KnowledgeBaseFormDialog';
import { useKnowledgeBases } from '@/features/knowledge/hooks/useKnowledgeBases';

/**
 * The Knowledge Base library (docs/07-knowledge-base.md §4.1).
 *
 * A knowledge base is a named subset of the user's documents that a
 * conversation can be scoped to. This page lists them; everything about one
 * base lives on its own route, because a base is a place with a URL.
 */
export function KnowledgeBasePage() {
  const bases = useKnowledgeBases();
  const [creating, setCreating] = useState(false);

  const items = bases.data?.items ?? [];

  return (
    <PageContainer title="Knowledge Base">
      <PageHeader
        title="Knowledge Base"
        description="Collections group related documents so a question can be answered from one body of material instead of everything you have ever uploaded."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" strokeWidth={1.5} aria-hidden="true" />
            New Knowledge Base
          </Button>
        }
      />

      {bases.isError && (
        <Alert tone="error" className="mt-8">
          {messageForError(bases.error)}
        </Alert>
      )}

      {bases.isPending ? (
        // Skeletons matching the final card geometry, not a spinner — a spinner
        // on a content surface reads as "broken" (docs/00-product.md §8.3).
        <div className="mt-8 grid gap-4 md:grid-cols-2" aria-busy="true" aria-label="Loading knowledge bases">
          {[0, 1].map((row) => (
            <Card key={row} className="p-5">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="mt-3 h-4 w-1/3" />
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <Card className="mt-8">
          <EmptyState
            icon={BookOpen}
            title="No collections yet"
            description="Group related documents into a collection, then scope a conversation to it so answers come from that material alone."
            action={
              <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                New Knowledge Base
              </Button>
            }
          />
        </Card>
      ) : (
        <ul className="mt-8 grid gap-4 md:grid-cols-2">
          {items.map((base) => (
            <li key={base.id}>
              <KnowledgeBaseCard base={base} />
            </li>
          ))}
        </ul>
      )}

      <KnowledgeBaseFormDialog open={creating} onClose={() => setCreating(false)} />
    </PageContainer>
  );
}

/**
 * One base.
 *
 * The whole card is the link rather than a title anchor with a card around it:
 * the target is the base, and a 40px-wide hit area inside a 300px card is a
 * pointing exercise on a phone.
 */
function KnowledgeBaseCard({ base }: { base: KnowledgeBaseDto }) {
  return (
    <Card interactive className="h-full">
      <Link
        to={buildRoute.knowledgeBase(base.id)}
        className="block h-full rounded-xl p-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="block truncate text-body font-medium text-primary">{base.name}</span>

        {base.description !== null && base.description.length > 0 && (
          <span className="mt-1 line-clamp-2 block text-body-sm text-secondary text-pretty">
            {base.description}
          </span>
        )}

        <span className="mt-3 block text-caption text-tertiary">
          {base.documentCount} {base.documentCount === 1 ? 'document' : 'documents'}
          {' · Updated '}
          {formatRelativeTime(base.updatedAt)}
        </span>
      </Link>
    </Card>
  );
}
