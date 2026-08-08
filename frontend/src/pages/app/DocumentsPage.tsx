import { useRef, useState } from 'react';
import { FileText, Upload } from 'lucide-react';
import { ACCEPTED_EXTENSIONS, MAX_FILES_PER_UPLOAD } from '@lumora/shared';
import { messageForError } from '@/constants/messages';
import { PageContainer } from '@/components/layout/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Skeleton } from '@/components/ui/Skeleton';
import { useDeleteDocument, useDocuments, useUploadDocuments } from '@/features/documents/hooks/useDocuments';
import { DocumentRow } from '@/features/documents/components/DocumentRow';

/** `accept` for the file input, from the shared contract. */
const ACCEPT = Object.keys(ACCEPTED_EXTENSIONS).join(',');

export function DocumentsPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rejections, setRejections] = useState<{ filename: string; message: string }[]>([]);

  const documents = useDocuments();
  const upload = useUploadDocuments();
  const remove = useDeleteDocument();

  const onFilesChosen = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setRejections([]);

    upload.mutate(Array.from(fileList).slice(0, MAX_FILES_PER_UPLOAD), {
      // Per-file rejections are not a failed request — the endpoint answers
      // 202 having accepted the rest — so they are surfaced separately from
      // the mutation's own error.
      onSuccess: (result) => setRejections(result.rejected),
    });

    // Reset, so choosing the same file twice fires a change event the second
    // time. Without this, a user who fixes a file and re-picks it sees nothing.
    if (inputRef.current) inputRef.current.value = '';
  };

  const items = documents.data?.items ?? [];

  return (
    <PageContainer title="Documents">
      <PageHeader
        title="Documents"
        description="PDFs, contracts, and notes that Lumora has read and indexed."
        actions={
          <Button
            variant="primary"
            loading={upload.isPending}
            iconLeft={<Upload className="size-4" strokeWidth={1.5} />}
            onClick={() => inputRef.current?.click()}
          >
            Upload
          </Button>
        }
      />

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        onChange={(event) => onFilesChosen(event.target.files)}
        aria-label="Choose documents to upload"
      />

      {upload.isError && (
        <Alert className="mt-6">{messageForError(upload.error)}</Alert>
      )}

      {rejections.length > 0 && (
        <Alert className="mt-6">
          <span className="font-medium">
            {rejections.length} {rejections.length === 1 ? 'file was' : 'files were'} not accepted:
          </span>
          <ul className="mt-1 space-y-0.5">
            {rejections.map((rejection) => (
              <li key={rejection.filename}>
                {rejection.filename} — {rejection.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {remove.isError && <Alert className="mt-6">{messageForError(remove.error)}</Alert>}

      <Card className="mt-8 overflow-hidden">
        {documents.isPending ? (
          /* Skeleton rows matching the real geometry, so nothing moves when
             the data arrives. */
          <div aria-busy="true" aria-label="Loading documents">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0">
                <Skeleton className="size-[1.125rem] shrink-0" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="mt-2 h-3 w-24" />
                </div>
                <Skeleton className="h-5 w-16 shrink-0" />
              </div>
            ))}
          </div>
        ) : documents.isError ? (
          <EmptyState
            icon={FileText}
            title="Could not load your documents"
            description={messageForError(documents.error)}
            action={
              <Button variant="secondary" onClick={() => void documents.refetch()}>
                Try again
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="Upload a PDF and Lumora will read it, split it into passages, and make it answerable."
            action={
              <Button
                variant="secondary"
                loading={upload.isPending}
                iconLeft={<Upload className="size-4" strokeWidth={1.5} />}
                onClick={() => inputRef.current?.click()}
              >
                Upload a document
              </Button>
            }
          />
        ) : (
          <div>
            {items.map((document) => (
              <DocumentRow
                key={document.id}
                document={document}
                deleting={remove.isPending && remove.variables === document.id}
                onDelete={(id) => remove.mutate(id)}
              />
            ))}
          </div>
        )}
      </Card>
    </PageContainer>
  );
}
