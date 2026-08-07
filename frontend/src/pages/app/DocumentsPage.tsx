import { FileText, Upload } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

export function DocumentsPage() {
  return (
    <PageContainer title="Documents">
      <PageHeader
        title="Documents"
        description="PDFs, contracts, and notes that Lumora has read and indexed."
        actions={
          <Button variant="primary" iconLeft={<Upload className="size-4" strokeWidth={1.5} />}>
            Upload
          </Button>
        }
      />

      <Card className="mt-8">
        <EmptyState
          icon={FileText}
          title="No documents yet"
          description="Upload a PDF and Lumora will read it, split it into passages, and make it answerable."
          action={
            <Button variant="secondary" iconLeft={<Upload className="size-4" strokeWidth={1.5} />}>
              Upload a document
            </Button>
          }
        />
      </Card>
    </PageContainer>
  );
}
