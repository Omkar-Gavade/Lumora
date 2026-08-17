import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FileText, MessageSquare, Pencil, Plus, Trash2, X } from 'lucide-react';
import { buildRoute } from '@/app/router/routes';
import { messageForError } from '@/constants/messages';
import { PageContainer } from '@/components/layout/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatBytes } from '@/lib/utils/format';
import { DeleteKnowledgeBaseDialog } from '@/features/knowledge/components/DeleteKnowledgeBaseDialog';
import { DocumentPickerDialog } from '@/features/knowledge/components/DocumentPickerDialog';
import { KnowledgeBaseFormDialog } from '@/features/knowledge/components/KnowledgeBaseFormDialog';
import {
  useKnowledgeBase,
  useKnowledgeBaseDocuments,
  useRemoveKnowledgeBaseDocument,
} from '@/features/knowledge/hooks/useKnowledgeBases';
import { useCreateConversation } from '@/features/chat/hooks/useChat';

/**
 * One knowledge base (docs/07-knowledge-base.md §4.3).
 *
 * Its members, and the four things you can do to it: add documents, remove
 * one, rename, delete — plus the action the whole feature exists for, which is
 * starting a conversation scoped to it.
 */
export function KnowledgeBaseDetailPage() {
  const { knowledgeBaseId } = useParams<{ knowledgeBaseId: string }>();
  const navigate = useNavigate();

  const base = useKnowledgeBase(knowledgeBaseId);
  const documents = useKnowledgeBaseDocuments(knowledgeBaseId);
  const removeDocument = useRemoveKnowledgeBaseDocument();
  const createConversation = useCreateConversation();

  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const items = documents.data?.items ?? [];

  if (base.isError) {
    return (
      <PageContainer title="Knowledge Base">
        <Alert tone="error">{messageForError(base.error)}</Alert>
      </PageContainer>
    );
  }

  if (base.isPending || base.data === undefined) {
    return (
      <PageContainer title="Knowledge Base">
        <Skeleton className="h-9 w-1/3" />
        <Skeleton className="mt-4 h-5 w-1/2" />
      </PageContainer>
    );
  }

  const startChat = () => {
    createConversation.mutate(
      { knowledgeBaseId: base.data.id },
      {
        onSuccess: (conversation) => {
          void navigate(buildRoute.conversation(conversation.id));
        },
      },
    );
  };

  return (
    <PageContainer title={base.data.name}>
      <PageHeader
        title={base.data.name}
        {...(base.data.description === null ? {} : { description: base.data.description })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={startChat}
              disabled={base.data.documentCount === 0 || createConversation.isPending}
            >
              <MessageSquare className="size-4" strokeWidth={1.5} aria-hidden="true" />
              Start chat
            </Button>
            <IconButton label="Rename knowledge base" onClick={() => setRenaming(true)}>
              <Pencil className="size-[1.125rem]" strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
            <IconButton label="Delete knowledge base" onClick={() => setDeleting(true)}>
              <Trash2 className="size-[1.125rem]" strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
          </div>
        }
      />

      <div className="mt-8 flex items-center justify-between gap-4">
        <h2 className="text-body font-medium text-primary">
          {base.data.documentCount} {base.data.documentCount === 1 ? 'document' : 'documents'}
        </h2>
        <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
          <Plus className="size-4" strokeWidth={1.5} aria-hidden="true" />
          Add documents
        </Button>
      </div>

      {documents.isError && (
        <Alert tone="error" className="mt-4">
          {messageForError(documents.error)}
        </Alert>
      )}

      {documents.isPending ? (
        <div className="mt-4 flex flex-col gap-2" aria-busy="true" aria-label="Loading documents">
          {[0, 1].map((row) => (
            <Skeleton key={row} className="h-14" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Card className="mt-4">
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="Add documents to this knowledge base so a conversation scoped to it has something to search."
            action={
              <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
                Add documents
              </Button>
            }
          />
        </Card>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {items.map((document) => (
            <li key={document.id}>
              <Card className="flex min-h-14 items-center gap-3 px-4 py-3">
                <FileText className="size-4 shrink-0 text-tertiary" strokeWidth={1.5} aria-hidden="true" />

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm text-primary">
                    {document.filename}
                  </span>
                  <span className="block text-caption text-tertiary">
                    {formatBytes(document.sizeBytes)}
                  </span>
                </span>

                {/*
                  "Remove from knowledge base", never "Delete". The two are one
                  tap apart and only one of them is reversible — the document
                  stays in the library either way, and the label has to say so.
                */}
                <IconButton
                  label={`Remove ${document.filename} from knowledge base`}
                  onClick={() => {
                    removeDocument.mutate({ id: base.data.id, documentId: document.id });
                  }}
                >
                  <X className="size-[1.125rem]" strokeWidth={1.5} aria-hidden="true" />
                </IconButton>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <DocumentPickerDialog
        open={picking}
        onClose={() => setPicking(false)}
        knowledgeBaseId={base.data.id}
        memberIds={items.map((document) => document.id)}
      />
      <KnowledgeBaseFormDialog
        open={renaming}
        onClose={() => setRenaming(false)}
        base={base.data}
      />
      <DeleteKnowledgeBaseDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        base={base.data}
      />
    </PageContainer>
  );
}
