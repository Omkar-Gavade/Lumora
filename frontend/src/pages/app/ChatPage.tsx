import { MessageSquare } from 'lucide-react';
import { ROUTES } from '@/app/router/routes';
import { PageContainer } from '@/components/layout/PageContainer';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/Button';
import { Link } from 'react-router-dom';

/**
 * Placeholder for the chat feature.
 *
 * Uses `bare` so the page owns its own vertical layout — the real thread will
 * scroll while a composer stays pinned, which the standard padded scroll
 * region cannot express. Standing the placeholder up in the final structure
 * now means the chat feature is dropped in, not fitted around.
 */
export function ChatPage() {
  return (
    <PageContainer title="Chat" bare>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon={MessageSquare}
          // The only heading on this screen, so it is the document's h1.
          titleAs="h1"
          title="Ask your documents anything"
          description="Add a document to your knowledge base, then ask a question. Every answer cites the passage it came from."
          action={
            <Button asChild variant="primary" size="lg">
              <Link to={ROUTES.documents}>Add a document</Link>
            </Button>
          }
        />
      </div>
    </PageContainer>
  );
}
