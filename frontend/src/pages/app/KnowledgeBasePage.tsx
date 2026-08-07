import { BookOpen } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Card } from '@/components/ui/Card';

export function KnowledgeBasePage() {
  return (
    <PageContainer title="Knowledge Base">
      <PageHeader
        title="Knowledge Base"
        description="Collections group related documents so a question can be answered from one body of material instead of everything you have ever uploaded."
      />

      <Card className="mt-8">
        <EmptyState
          icon={BookOpen}
          title="No collections yet"
          description="Collections will appear here once the knowledge base feature ships."
        />
      </Card>
    </PageContainer>
  );
}
