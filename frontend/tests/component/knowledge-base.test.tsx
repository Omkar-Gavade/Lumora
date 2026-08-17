import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { DocumentDto, KnowledgeBaseDto } from '@lumora/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeBasePage } from '@/pages/app/KnowledgeBasePage';
import { KnowledgeBaseDetailPage } from '@/pages/app/KnowledgeBaseDetailPage';
import * as knowledgeApi from '@/features/knowledge/api/knowledge.api';
import * as documentsApi from '@/features/documents/api/documents.api';

/**
 * Knowledge Base UI (docs/07-knowledge-base.md §4).
 *
 * The API module is mocked rather than `fetch`: what matters here is what the
 * component does with a list, a selection, or a failure — and going through
 * the transport would test the client on every assertion.
 */

vi.mock('@/features/knowledge/api/knowledge.api');
vi.mock('@/features/documents/api/documents.api');

const BASE: KnowledgeBaseDto = {
  id: 'kb-1',
  name: 'Mental Health',
  description: 'Therapy notes',
  documentCount: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function document(overrides: Partial<DocumentDto> & { id: string }): DocumentDto {
  return {
    filename: 'notes.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    status: 'ready',
    errorCode: null,
    errorMessage: null,
    pageCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as DocumentDto;
}

function wrap(node: React.ReactNode, path = '/app/knowledge') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/knowledge" element={node} />
          <Route path="/app/knowledge/:knowledgeBaseId" element={node} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(documentsApi.listDocuments).mockResolvedValue({ items: [], nextCursor: null });
});

describe('knowledge base list', () => {
  it('lists bases with their document counts', async () => {
    vi.mocked(knowledgeApi.listKnowledgeBases).mockResolvedValue({
      items: [BASE, { ...BASE, id: 'kb-2', name: 'AWS', documentCount: 3 }],
    });

    wrap(<KnowledgeBasePage />);

    expect(await screen.findByRole('link', { name: /Mental Health/ })).toBeInTheDocument();
    expect(screen.getByText(/3 documents/)).toBeInTheDocument();
    expect(screen.getByText(/1 document(?!s)/)).toBeInTheDocument();
  });

  it('links each card to its own route', async () => {
    vi.mocked(knowledgeApi.listKnowledgeBases).mockResolvedValue({ items: [BASE] });

    wrap(<KnowledgeBasePage />);

    expect(await screen.findByRole('link', { name: /Mental Health/ })).toHaveAttribute(
      'href',
      '/app/knowledge/kb-1',
    );
  });

  it('shows the empty state when there are none', async () => {
    vi.mocked(knowledgeApi.listKnowledgeBases).mockResolvedValue({ items: [] });

    wrap(<KnowledgeBasePage />);

    expect(await screen.findByText('No collections yet')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty list', async () => {
    // An error rendered as "no collections" tells the user their data is gone.
    vi.mocked(knowledgeApi.listKnowledgeBases).mockRejectedValue(new Error('boom'));

    wrap(<KnowledgeBasePage />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('creates a base from the dialog', async () => {
    vi.mocked(knowledgeApi.listKnowledgeBases).mockResolvedValue({ items: [] });
    vi.mocked(knowledgeApi.createKnowledgeBase).mockResolvedValue(BASE);

    const user = userEvent.setup();
    wrap(<KnowledgeBasePage />);

    await user.click(await screen.findByRole('button', { name: 'New Knowledge Base' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Name'), 'Mental Health');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(knowledgeApi.createKnowledgeBase).toHaveBeenCalledWith({ name: 'Mental Health' });
    });
  });

  it('will not submit an empty name', async () => {
    vi.mocked(knowledgeApi.listKnowledgeBases).mockResolvedValue({ items: [] });

    const user = userEvent.setup();
    wrap(<KnowledgeBasePage />);

    await user.click(await screen.findByRole('button', { name: 'New Knowledge Base' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('closes the create dialog on Escape', async () => {
    vi.mocked(knowledgeApi.listKnowledgeBases).mockResolvedValue({ items: [] });

    const user = userEvent.setup();
    wrap(<KnowledgeBasePage />);

    await user.click(await screen.findByRole('button', { name: 'New Knowledge Base' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

describe('knowledge base detail', () => {
  beforeEach(() => {
    vi.mocked(knowledgeApi.getKnowledgeBase).mockResolvedValue(BASE);
    vi.mocked(knowledgeApi.listKnowledgeBaseDocuments).mockResolvedValue({
      items: [document({ id: 'doc-1', filename: 'cbt.pdf' })],
    });
    vi.mocked(knowledgeApi.listKnowledgeBases).mockResolvedValue({ items: [BASE] });
  });

  it('shows the base and its documents', async () => {
    wrap(<KnowledgeBaseDetailPage />, '/app/knowledge/kb-1');

    expect(await screen.findByRole('heading', { name: 'Mental Health' })).toBeInTheDocument();
    expect(await screen.findByText('cbt.pdf')).toBeInTheDocument();
  });

  it('**labels removal as "remove from knowledge base", never delete**', async () => {
    // The two are one tap apart and only one is reversible. The label is the
    // only thing standing between them.
    wrap(<KnowledgeBaseDetailPage />, '/app/knowledge/kb-1');

    expect(
      await screen.findByRole('button', { name: 'Remove cbt.pdf from knowledge base' }),
    ).toBeInTheDocument();
  });

  it('removes a document without deleting it', async () => {
    vi.mocked(knowledgeApi.removeKnowledgeBaseDocument).mockResolvedValue(undefined);

    const user = userEvent.setup();
    wrap(<KnowledgeBaseDetailPage />, '/app/knowledge/kb-1');

    await user.click(
      await screen.findByRole('button', { name: 'Remove cbt.pdf from knowledge base' }),
    );

    await waitFor(() => {
      expect(knowledgeApi.removeKnowledgeBaseDocument).toHaveBeenCalledWith('kb-1', 'doc-1');
    });
    // The document API is never touched — removal is a filing change.
    expect(documentsApi.deleteDocument).not.toHaveBeenCalled();
  });

  it('shows the empty state for a base with no documents', async () => {
    vi.mocked(knowledgeApi.listKnowledgeBaseDocuments).mockResolvedValue({ items: [] });

    wrap(<KnowledgeBaseDetailPage />, '/app/knowledge/kb-1');

    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
  });

  it('**warns that documents survive and conversations become unscoped**', async () => {
    vi.mocked(knowledgeApi.getKnowledgeBaseImpact).mockResolvedValue({ conversationCount: 3 });

    const user = userEvent.setup();
    wrap(<KnowledgeBaseDetailPage />, '/app/knowledge/kb-1');

    await user.click(await screen.findByRole('button', { name: 'Delete knowledge base' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/documents will not be deleted/i)).toBeInTheDocument();
    expect(await within(dialog).findByText(/3 conversations will become unscoped/i)).toBeInTheDocument();
  });

  it('starts a chat scoped to the base', async () => {
    const user = userEvent.setup();
    wrap(<KnowledgeBaseDetailPage />, '/app/knowledge/kb-1');

    await user.click(await screen.findByRole('button', { name: 'Start chat' }));

    // The scope is sent to the server, which is the only authority on it.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Start chat' })).toBeDisabled();
    });
  });

  it('disables Start chat for an empty base', async () => {
    // A scoped conversation with nothing in scope can only abstain.
    vi.mocked(knowledgeApi.getKnowledgeBase).mockResolvedValue({ ...BASE, documentCount: 0 });
    vi.mocked(knowledgeApi.listKnowledgeBaseDocuments).mockResolvedValue({ items: [] });

    wrap(<KnowledgeBaseDetailPage />, '/app/knowledge/kb-1');

    expect(await screen.findByRole('button', { name: 'Start chat' })).toBeDisabled();
  });

  it('**shows members as already added and prevents re-adding them**', async () => {
    const user = userEvent.setup();
    vi.mocked(documentsApi.listDocuments).mockResolvedValue({
      items: [
        document({ id: 'doc-1', filename: 'cbt.pdf' }),
        document({ id: 'doc-2', filename: 'aws.pdf' }),
      ],
      nextCursor: null,
    });

    wrap(<KnowledgeBaseDetailPage />, '/app/knowledge/kb-1');

    await user.click(await screen.findByRole('button', { name: 'Add documents' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('cbt.pdf')).toBeDisabled();
    expect(within(dialog).getByLabelText('aws.pdf')).not.toBeDisabled();
  });

  it('**does not offer documents that are still processing**', async () => {
    const user = userEvent.setup();
    vi.mocked(documentsApi.listDocuments).mockResolvedValue({
      items: [document({ id: 'doc-9', filename: 'busy.pdf', status: 'embedding' })],
      nextCursor: null,
    });

    wrap(<KnowledgeBaseDetailPage />, '/app/knowledge/kb-1');

    await user.click(await screen.findByRole('button', { name: 'Add documents' }));

    const dialog = await screen.findByRole('dialog');
    // A document with no chunks yet would make the base silently under-answer.
    expect(within(dialog).getByLabelText('busy.pdf')).toBeDisabled();
  });

  it('adds selected documents', async () => {
    vi.mocked(knowledgeApi.addKnowledgeBaseDocuments).mockResolvedValue({
      added: 1,
      alreadyPresent: 0,
      documentCount: 2,
    });
    vi.mocked(documentsApi.listDocuments).mockResolvedValue({
      items: [document({ id: 'doc-2', filename: 'aws.pdf' })],
      nextCursor: null,
    });

    const user = userEvent.setup();
    wrap(<KnowledgeBaseDetailPage />, '/app/knowledge/kb-1');

    await user.click(await screen.findByRole('button', { name: 'Add documents' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('aws.pdf'));
    await user.click(within(dialog).getByRole('button', { name: 'Add 1' }));

    await waitFor(() => {
      expect(knowledgeApi.addKnowledgeBaseDocuments).toHaveBeenCalledWith('kb-1', ['doc-2']);
    });
  });
});
