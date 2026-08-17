import { useMemo, useState } from 'react';
import type { DocumentDto } from '@lumora/shared';
import { messageForError } from '@/constants/messages';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Dialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatBytes } from '@/lib/utils/format';
import { useDocuments } from '@/features/documents/hooks/useDocuments';
import { useAddKnowledgeBaseDocuments } from '../hooks/useKnowledgeBases';

interface DocumentPickerDialogProps {
  open: boolean;
  onClose: () => void;
  knowledgeBaseId: string;
  /** Ids already in the base — shown checked and disabled. */
  memberIds: string[];
}

/**
 * Adds documents to a knowledge base (docs/07-knowledge-base.md §4.4).
 *
 * Reuses `useDocuments`, the library's own query, rather than adding a
 * knowledge-base-specific document endpoint — there is one document list in
 * this product and this is a view of it.
 *
 * Only `ready` documents can be selected. A document still being processed has
 * no chunks yet, so adding it would produce a base that silently under-answers
 * until ingestion finishes, with nothing on screen to explain why.
 */
export function DocumentPickerDialog({
  open,
  onClose,
  knowledgeBaseId,
  memberIds,
}: DocumentPickerDialogProps) {
  const documents = useDocuments();
  const add = useAddKnowledgeBaseDocuments();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const members = useMemo(() => new Set(memberIds), [memberIds]);
  const items = documents.data?.items ?? [];

  const close = () => {
    setSelected(new Set());
    add.reset();
    onClose();
  };

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = () => {
    if (selected.size === 0) return;

    add.mutate({ id: knowledgeBaseId, documentIds: [...selected] }, { onSuccess: close });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title="Add documents"
      description="Only documents that have finished processing can be added."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={selected.size === 0 || add.isPending}>
            {selected.size === 0 ? 'Add' : `Add ${String(selected.size)}`}
          </Button>
        </>
      }
    >
      {add.error !== null && (
        <Alert tone="error" className="mb-4">
          {messageForError(add.error)}
        </Alert>
      )}

      {documents.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading documents">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-11" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-body-sm text-secondary">
          You have not uploaded any documents yet. Add one from the Documents page first.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((document) => (
            <DocumentOption
              key={document.id}
              document={document}
              member={members.has(document.id)}
              checked={selected.has(document.id)}
              onToggle={() => toggle(document.id)}
            />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function DocumentOption({
  document,
  member,
  checked,
  onToggle,
}: {
  document: DocumentDto;
  member: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const ready = document.status === 'ready';
  const disabled = member || !ready;

  return (
    <li>
      <label
        className={[
          'flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2.5 py-2',
          disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-hover',
        ].join(' ')}
      >
        <Checkbox
          checked={member || checked}
          disabled={disabled}
          onChange={onToggle}
          aria-label={document.filename}
        />

        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-sm text-primary">{document.filename}</span>
          <span className="block text-caption text-tertiary">
            {formatBytes(document.sizeBytes)}
            {member ? ' · Already added' : ready ? '' : ` · ${document.status}`}
          </span>
        </span>
      </label>
    </li>
  );
}
