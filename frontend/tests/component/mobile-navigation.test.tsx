import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ConversationDto, UserDto } from '@lumora/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_BELOW_MD } from '@/hooks/useMediaQuery';
import { SidebarProvider, useSidebar } from '@/app/providers/SidebarProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { MobileSidebar } from '@/components/layout/sidebar/Sidebar';
import * as chatApi from '@/features/chat/api/chat.api';

/**
 * Mobile navigation (docs/00-product.md §8.3 responsive, docs/01 §7).
 *
 * Below `md` the sidebar is the *only* navigation surface — there is no second
 * conversation column any more — so these cover the things that make a drawer
 * usable rather than merely present: it closes on Escape, on the scrim, and on
 * picking a destination, and it does not strand focus behind itself.
 */

vi.mock('@/features/chat/api/chat.api');

vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => ({ signOut: vi.fn(), refreshUser: vi.fn() }),
  useAuthenticatedUser: (): UserDto => ({
    id: 'user-1',
    email: 'person@example.test',
    displayName: 'Test Person',
    emailVerified: true,
    createdAt: new Date().toISOString(),
  }),
}));

vi.mock('@/features/documents/hooks/useDocuments', () => ({
  useStorageUsage: () => ({ data: { usedBytes: 0, limitBytes: 1000 }, isPending: false }),
}));

function conversation(id: string, title: string): ConversationDto {
  const now = new Date().toISOString();
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    messageCount: 2,
  } as ConversationDto;
}

/** Reports a match for the below-`md` query only, so the shell is on a phone. */
function useMobileViewport() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query === MEDIA_BELOW_MD,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

/** Stands in for the header's menu button, which lives outside the drawer. */
function OpenButton() {
  const { openDrawer } = useSidebar();
  return (
    <button type="button" onClick={openDrawer}>
      Open navigation
    </button>
  );
}

function renderShell(conversations: ConversationDto[], at = '/app/chat') {
  vi.mocked(chatApi.listConversations).mockResolvedValue({
    items: conversations,
    nextCursor: null,
  });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[at]}>
          <SidebarProvider>
            <OpenButton />
            <Routes>
              <Route path="/app/chat" element={<MobileSidebar />} />
              <Route path="/app/chat/:conversationId" element={<MobileSidebar />} />
              <Route path="/app/documents" element={<MobileSidebar />} />
            </Routes>
          </SidebarProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** The drawer stays mounted and is `inert` while closed — see Sidebar.tsx. */
function drawer() {
  return screen.getByRole('dialog', { name: 'Navigation', hidden: true });
}

function isOpen() {
  return !drawer().hasAttribute('inert');
}

beforeEach(() => {
  vi.clearAllMocks();
  useMobileViewport();
});

afterEach(() => {
  document.body.style.overflow = '';
});

describe('Mobile navigation drawer', () => {
  it('opens from the header control and closes on its own close button', async () => {
    const user = userEvent.setup();
    renderShell([]);

    expect(isOpen()).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(isOpen()).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(isOpen()).toBe(false);
  });

  it('moves focus into the drawer on open', async () => {
    const user = userEvent.setup();
    renderShell([]);

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));

    // Without this the next Tab continues from the header button, behind the
    // scrim, on content the user cannot see or click.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveFocus();
    });
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderShell([]);

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(isOpen()).toBe(true);

    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(false);
  });

  it('closes when the scrim is tapped', async () => {
    const user = userEvent.setup();
    const { container } = renderShell([]);

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(isOpen()).toBe(true);

    // The scrim is aria-hidden and carries no keyboard affordance on purpose,
    // so it is reached by query rather than by role.
    const scrim = container.querySelector('[aria-hidden="true"].fixed');
    if (scrim === null) throw new Error('The drawer rendered without its scrim.');
    await user.click(scrim);

    expect(isOpen()).toBe(false);
  });

  it('locks the page behind it while open', async () => {
    const user = userEvent.setup();
    renderShell([]);

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(document.body).toHaveStyle({ overflow: 'hidden' });

    await user.keyboard('{Escape}');
    expect(document.body).not.toHaveStyle({ overflow: 'hidden' });
  });

  it('shows recent conversations inside the drawer', async () => {
    const user = userEvent.setup();
    renderShell([conversation('a', 'Retrieval Pipeline')]);

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));

    // The whole point of the change: on a phone this list exists at all.
    expect(await screen.findByRole('link', { name: 'Retrieval Pipeline' })).toBeInTheDocument();
  });

  it('closes when a conversation is selected', async () => {
    const user = userEvent.setup();
    renderShell([conversation('a', 'Retrieval Pipeline')]);

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(await screen.findByRole('link', { name: 'Retrieval Pipeline' }));

    await waitFor(() => {
      expect(isOpen()).toBe(false);
    });
  });

  it('closes when a workspace destination is selected', async () => {
    const user = userEvent.setup();
    renderShell([]);

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(screen.getByRole('link', { name: 'Documents' }));

    await waitFor(() => {
      expect(isOpen()).toBe(false);
    });
  });

  it('closes on New chat even when already on the chat route', async () => {
    const user = userEvent.setup();
    renderShell([], '/app/chat');

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(isOpen()).toBe(true);

    /*
      The drawer derives "open" from the route it was opened on, so a link back
      to the route you are already on changes nothing and would leave the
      drawer sitting over an empty composer. This is the case that derivation
      cannot see.
    */
    await user.click(screen.getByRole('link', { name: 'New chat' }));

    await waitFor(() => {
      expect(isOpen()).toBe(false);
    });
  });

  it('keeps Settings reachable from the drawer', async () => {
    const user = userEvent.setup();
    renderShell([]);

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));

    for (const label of ['Chat', 'Knowledge Base', 'Documents', 'Search', 'Settings']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });
});
