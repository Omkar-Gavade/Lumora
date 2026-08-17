import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KB_DESCRIPTION_MAX_LENGTH, KB_NAME_MAX_LENGTH, type KnowledgeBaseDto } from '@lumora/shared';
import { buildRoute } from '@/app/router/routes';
import { messageForError } from '@/constants/messages';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { useCreateKnowledgeBase, useUpdateKnowledgeBase } from '../hooks/useKnowledgeBases';

interface KnowledgeBaseFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Present when editing. Absent when creating. */
  base?: KnowledgeBaseDto;
}

/**
 * Create or rename a knowledge base.
 *
 * One dialog for both, because the fields and the validation are identical and
 * the only difference is where the result goes — a new base opens, an edited
 * one stays put. Two components would be the same form twice.
 */
export function KnowledgeBaseFormDialog({ open, onClose, base }: KnowledgeBaseFormDialogProps) {
  const navigate = useNavigate();
  const create = useCreateKnowledgeBase();
  const update = useUpdateKnowledgeBase();

  const editing = base !== undefined;
  const [name, setName] = useState(base?.name ?? '');
  const [description, setDescription] = useState(base?.description ?? '');

  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const trimmed = name.trim();

  const close = () => {
    if (!editing) {
      setName('');
      setDescription('');
    }
    create.reset();
    update.reset();
    onClose();
  };

  const submit = (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (trimmed.length === 0 || pending) return;

    if (editing) {
      update.mutate(
        {
          id: base.id,
          // An emptied field clears the description rather than storing "".
          changes: { name: trimmed, description: description.trim() || null },
        },
        { onSuccess: close },
      );
      return;
    }

    create.mutate(
      { name: trimmed, ...(description.trim() ? { description: description.trim() } : {}) },
      {
        onSuccess: (created) => {
          close();
          // Straight into the new base, whose only useful next action is
          // adding documents to it.
          void navigate(buildRoute.knowledgeBase(created.id));
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={editing ? 'Rename knowledge base' : 'New Knowledge Base'}
      {...(editing
        ? {}
        : {
            description:
              'Group related documents so a conversation can be answered from them alone.',
          })}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="knowledge-base-form" disabled={trimmed.length === 0 || pending}>
            {editing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="knowledge-base-form" onSubmit={submit} className="flex flex-col gap-4">
        {error !== null && <Alert tone="error">{messageForError(error)}</Alert>}

        <FormField label="Name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={KB_NAME_MAX_LENGTH}
            placeholder="Research papers"
          />
        </FormField>

        <FormField label="Description" hint="Optional">
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={KB_DESCRIPTION_MAX_LENGTH}
            placeholder="Papers for the literature review"
          />
        </FormField>
      </form>
    </Dialog>
  );
}
