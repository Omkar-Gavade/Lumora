import { Link } from 'react-router-dom';
import { ROUTES } from '@/app/router/routes';
import { PageContainer } from '@/components/layout/PageContainer';
import { StatusPage } from '@/components/common/StatusPage';
import { Button } from '@/components/ui/Button';

/**
 * 404 inside the shell. The sidebar, header, and theme stay exactly where they
 * were — losing the whole application because one URL was wrong is a far worse
 * failure than the wrong URL.
 */
export function AppNotFoundPage() {
  return (
    <PageContainer title="Page not found" bare>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <StatusPage
          code="404"
          title="We couldn’t find that page"
          description="It may have been renamed or removed. Everything else is where you left it."
          actions={
            <Button asChild variant="primary" size="lg">
              <Link to={ROUTES.chat}>Back to chat</Link>
            </Button>
          }
        />
      </div>
    </PageContainer>
  );
}
