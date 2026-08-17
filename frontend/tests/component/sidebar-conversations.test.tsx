import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ConversationDto, ConversationListDto } from '@lumora/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarConversations } from '@/components/layout/sidebar/SidebarConversations';
import { SidebarProvider } from '@/app/providers/SidebarProvider';
import * as chatApi from '@/features/chat/api/chat.api';

/**
 * Conversation history in the primary navigation (docs/00-product.md FR-21).
 *
 * The API module is mocked rather than `fetch`: what matters here is what the
 * component does with a list — how it groups it, which row it marks current,
 * what a rename commits — and going through the transport would test the
 * client on every assertion.
 */

vi.mock('@/features/chat/api/chat.api');

const DAY = 24 * 60 * 60 * 1000;

function conversation(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
  const now = new Date().toISOString();
  return {
    title: 'Untitled',
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    messageCount: 2,
    ...overrides,
  } as ConversationDto;
}

function listOf(items: ConversationDto[]): ConversationListDto {
  return { items, nextCursor: null };
}

/**
 * Renders the sidebar at a conversation URL so `useParams` resolves, matching
 * how the component is actually mounted inside the app shell.
 */
function wrap(items: ConversationDto[], activeId?: string) {
  vi.mocked(chatApi.listConversations).mockResolvedValue(listOf(items));

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const path = activeId === undefined ? '/app/chat' : `/app/chat/${activeId}`;

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SidebarProvider>
          <Routes>
            <Route path="/app/chat" element={<SidebarConversations collapsed={false} />} />
            <Route
              path="/app/chat/:conversationId"
              element={<SidebarConversations collapsed={false} />}
            />
          </Routes>
        </SidebarProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Recent conversations', () => {
  it('renders conversations grouped by recency', async () => {
    const now = Date.now();
    wrap([
      conversation({ id: 'a', title: 'Retrieval Pipeline', lastMessageAt: new Date(now).toISOString() }),
      conversation({
        id: 'b',
        title: 'Kubernetes Ingress',
        lastMessageAt: new Date(now - DAY - 60_000).toISOString(),
      }),
    ]);

    expect(await screen.findByRole('link', { name: 'Retrieval Pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kubernetes Ingress' })).toBeInTheDocument();

    // The buckets are the product's, not an elapsed-time approximation.
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeInTheDocument();
  });

  it('marks the open conversation as current', async () => {
    wrap(
      [
        conversation({ id: 'a', title: 'Open one' }),
        conversation({ id: 'b', title: 'Other one' }),
      ],
      'a',
    );

    const open = await screen.findByRole('link', { name: 'Open one' });
    // `aria-current="page"` rather than a class assertion: the styling is the
    // design system's to change, the semantics are the contract.
    expect(open).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Other one' })).not.toHaveAttribute('aria-current');
  });

  it('links each row to its conversation route', async () => {
    wrap([conversation({ id: 'abc-123', title: 'Somewhere' })]);

    expect(await screen.findByRole('link', { name: 'Somewhere' })).toHaveAttribute(
      'href',
      '/app/chat/abc-123',
    );
  });

  it('shows the designed empty state when there is no history', async () => {
    wrap([]);

    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
  });

  it('renders nothing on the collapsed rail', () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue(listOf([]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/app/chat']}>
          <SidebarProvider>
            <SidebarConversations collapsed />
          </SidebarProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // A column of identical chat glyphs carries no information; the group is
    // dropped rather than rendered as decoration.
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps a long title on one row instead of widening the panel', async () => {
    wrap([
      conversation({
        id: 'a',
        title: 'An extremely long conversation title that would otherwise push the sidebar wider',
      }),
    ]);

    const link = await screen.findByRole('link', { name: /extremely long conversation/ });
    expect(link.querySelector('span')).toHaveClass('truncate');
  });

  it('renames a conversation and can be cancelled with Escape', async () => {
    vi.mocked(chatApi.renameConversation).mockResolvedValue(
      conversation({ id: 'a', title: 'New name' }),
    );
    const user = userEvent.setup();
    wrap([conversation({ id: 'a', title: 'Old name' })]);

    await user.click(await screen.findByRole('button', { name: 'Actions for Old name' }));
    await user.click(screen.getByRole('menuitem', { name: /rename/i }));

    const field = screen.getByLabelText('Conversation title');
    await user.clear(field);
    await user.type(field, 'Abandoned edit');
    await user.keyboard('{Escape}');

    expect(chatApi.renameConversation).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Old name' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions for Old name' }));
    await user.click(screen.getByRole('menuitem', { name: /rename/i }));

    const reopened = screen.getByLabelText('Conversation title');
    await user.clear(reopened);
    await user.type(reopened, 'New name{Enter}');

    expect(chatApi.renameConversation).toHaveBeenCalledWith('a', 'New name');
  });

  it('deletes a conversation from the row menu', async () => {
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap([conversation({ id: 'a', title: 'Doomed' })]);

    await user.click(await screen.findByRole('button', { name: 'Actions for Doomed' }));
    await user.click(screen.getByRole('menuitem', { name: /delete/i }));

    expect(chatApi.deleteConversation).toHaveBeenCalledWith('a');
  });

  it('keeps the row action reachable without a hover', async () => {
    wrap([conversation({ id: 'a', title: 'Reachable' })]);

    // Hover-only actions are an accessibility failure (docs/00-product.md
    // §8.3) and on a touch screen there is no hover at all — so the trigger is
    // in the DOM and focusable regardless of pointer state.
    const trigger = await screen.findByRole('button', { name: 'Actions for Reachable' });
    trigger.focus();
    expect(trigger).toHaveFocus();
  });

  it('groups every bucket the product defines', async () => {
    const now = Date.now();
    wrap([
      conversation({ id: 'a', title: 'Now', lastMessageAt: new Date(now).toISOString() }),
      conversation({ id: 'b', title: 'Yest', lastMessageAt: new Date(now - DAY - 60_000).toISOString() }),
      conversation({ id: 'c', title: 'Week', lastMessageAt: new Date(now - 4 * DAY).toISOString() }),
      conversation({ id: 'd', title: 'Old', lastMessageAt: new Date(now - 90 * DAY).toISOString() }),
    ]);

    // Awaiting a row rather than the list: the `<ul>` is present while the
    // query is still pending, so finding it proves nothing has loaded yet.
    await screen.findByRole('link', { name: 'Now' });

    const recent = screen.getByRole('list', { name: 'Recent' });
    for (const label of ['Today', 'Yesterday', 'Previous 7 days', 'Earlier']) {
      expect(within(recent).getByRole('heading', { name: label })).toBeInTheDocument();
    }
  });
});
