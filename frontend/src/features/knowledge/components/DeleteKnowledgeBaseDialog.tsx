import { useNavigate } from 'react-router-dom';
import type { KnowledgeBaseDto } from '@lumora/shared';
import { ROUTES } from '@/app/router/routes';
import { messageForError } from '@/constants/messages';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { useDeleteKnowledgeBase, useKnowledgeBaseImpact } from '../hooks/useKnowledgeBases';

interface DeleteKnowledgeBaseDialogProps {
  open: boolean;
  onClose: () => void;
  base: KnowledgeBaseDto;
}

/**
 * Deleting a knowledge base (docs/07-knowledge-base.md §4.7).
 *
 * The confirmation states the two things a user cannot see from the button:
 * that their **documents survive**, and how many conversations lose their
 * scope. Both are consequences of the foreign keys — memberships cascade,
 * conversations are set to NULL — and neither is guessable from the word
 * "delete", which in every other part of this product destroys the thing named.
 */
export function DeleteKnowledgeBaseDialog({ open, onClose, base }: DeleteKnowledgeBaseDialogProps) {
  const navigate = useNavigate();
  const remove = useDeleteKnowledgeBase();
  // Only while the dialog is open: the count is worthless until someone is
  // deciding, and fetching it per card would be a request per row.
  const impact = useKnowledgeBaseImpact(base.id, open);

  const conversationCount = impact.data?.conversationCount ?? 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Delete “${base.name}”?`}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate(base.id, {
                onSuccess: () => {
                  onClose();
                  void navigate(ROUTES.knowledge);
                },
              });
            }}
          >
            Delete knowledge base
          </Button>
        </>
      }
    >
      {remove.error !== null && (
        <Alert tone="error" className="mb-4">
          {messageForError(remove.error)}
        </Alert>
      )}

      <p className="text-body-sm text-secondary text-pretty">
        This removes the knowledge base and its document associations.{' '}
        <strong className="font-medium text-primary">Your documents will not be deleted</strong> —
        they stay in your library and remain searchable.
      </p>

      {conversationCount > 0 && (
        <p className="mt-3 text-body-sm text-secondary text-pretty">
          {conversationCount === 1
            ? '1 conversation will become unscoped'
            : `${String(conversationCount)} conversations will become unscoped`}{' '}
          and will search all of your documents from now on. Their history is kept.
        </p>
      )}
    </Dialog>
  );
}
