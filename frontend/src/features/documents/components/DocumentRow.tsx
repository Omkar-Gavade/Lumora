import { useState } from 'react';
import { FileText, Loader2, Trash2 } from 'lucide-react';
import type { DocumentDto, DocumentStatus } from '@lumora/shared';
import { cn } from '@/lib/utils/cn';
import { formatBytes } from '@/lib/utils/format';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/IconButton';

/**
 * FR-13: status is live and honest, with a human-readable failure reason.
 *
 * Every stage gets its own label rather than collapsing the four working
 * states into "processing". A user watching a 200-page PDF wants to know it is
 * embedding rather than still parsing — an undifferentiated spinner is what
 * makes a slow operation feel stuck.
 */
const STATUS_LABEL: Record<DocumentStatus, string> = {
  queued: 'Queued',
  parsing: 'Reading',
  chunking: 'Splitting',
  embedding: 'Indexing',
  ready: 'Ready',
  failed: 'Failed',
};

const IN_PROGRESS: DocumentStatus[] = ['queued', 'parsing', 'chunking', 'embedding'];

function StatusPill({ document }: { document: DocumentDto }) {
  if (document.status === 'ready') {
    return (
      <Badge variant="success" size="sm">
        Ready
      </Badge>
    );
  }

  if (document.status === 'failed') {
    return (
      <Badge variant="danger" size="sm">
        Failed
      </Badge>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-secondary">
      {/* The one place a spinner earns its keep: work really is ongoing, and
          the label says which stage. */}
      <Loader2 className="size-3 animate-spin" strokeWidth={2} aria-hidden="true" />
      {STATUS_LABEL[document.status]}
    </span>
  );
}

interface DocumentRowProps {
  document: DocumentDto;
  onDelete: (id: string) => void;
  deleting: boolean;
}

export function DocumentRow({ document, onDelete, deleting }: DocumentRowProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div
      className={cn(
        'flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0',
        'transition-colors duration-150 hover:bg-hover',
        deleting && 'opacity-50',
      )}
    >
      <FileText className="size-[1.125rem] shrink-0 text-tertiary" strokeWidth={1.5} aria-hidden="true" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-body-sm font-medium text-primary">{document.filename}</p>
        <p className="mt-0.5 truncate text-caption text-tertiary">
          <span className="tabular">{formatBytes(document.sizeBytes)}</span>
          {document.pageCount !== null && <> · {document.pageCount} pages</>}
          {/* FR-13: the reason, not just the state. */}
          {document.status === 'failed' && document.errorMessage && (
            <> · <span className="text-danger">{document.errorMessage}</span></>
          )}
        </p>
      </div>

      <div className="shrink-0">
        <StatusPill document={document} />
      </div>

      {confirming ? (
        /*
          Inline confirmation rather than a modal. FR-15 says deletion is
          complete and the UI says so — a two-word warning next to the row it
          affects is read; a dialog that covers the list is dismissed.
        */
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-caption text-secondary">Delete permanently?</span>
          <button
            type="button"
            onClick={() => onDelete(document.id)}
            disabled={deleting}
            className="cursor-pointer rounded-xs text-caption font-medium text-danger hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="cursor-pointer rounded-xs text-caption text-secondary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Cancel
          </button>
        </div>
      ) : (
        <IconButton
          label={`Delete ${document.filename}`}
          onClick={() => setConfirming(true)}
          disabled={deleting}
          className="shrink-0"
        >
          <Trash2 className="size-4" strokeWidth={1.5} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}

export { IN_PROGRESS };
