import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MessageSquare, Send } from 'lucide-react';
import { MAX_MESSAGE_LENGTH, type TurnDto } from '@lumora/shared';
import { ROUTES, buildRoute } from '@/app/router/routes';
import { messageForError } from '@/constants/messages';
import { PageContainer } from '@/components/layout/PageContainer';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Skeleton } from '@/components/ui/Skeleton';
import { ConversationList } from '@/features/chat/components/ConversationList';
import { MessageBubble } from '@/features/chat/components/MessageBubble';
import {
  useConversation,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  useRenameConversation,
  useSendMessage,
} from '@/features/chat/hooks/useChat';

/**
 * The chat surface.
 *
 * The turn is request/response here rather than streamed; the SSE orchestrator
 * is the next milestone and replaces one hook, not this layout. Everything
 * around it — the thread, the sources, the actions, the states — is what it
 * will be.
 */
export function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();

  const conversations = useConversations();
  const thread = useConversation(conversationId);
  const create = useCreateConversation();
  const rename = useRenameConversation();
  const remove = useDeleteConversation();
  const send = useSendMessage();

  const [draft, setDraft] = useState('');
  /**
   * The turn just answered, tagged with the thread it belongs to.
   *
   * Tagged rather than cleared by an effect on `conversationId`: setting state
   * from an effect costs an extra render and, for one frame, shows the previous
   * thread's sources under the new thread's messages. Comparing the tag at
   * render is both correct and free.
   */
  const [lastTurn, setLastTurn] = useState<{ conversationId: string; turn: TurnDto } | null>(null);
  const currentTurn = lastTurn !== null && lastTurn.conversationId === conversationId ? lastTurn.turn : null;

  const threadRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const messages = thread.data?.messages ?? [];

  /*
    Auto-scroll, but only when the user is already at the bottom.

    Scrolling someone back down while they are reading an earlier answer is the
    single most irritating thing a chat UI can do. The ref is written by the
    scroll handler and read here, so the decision is made from where the user
    actually is rather than from a state value that lags a frame behind.
  */
  useEffect(() => {
    if (!atBottomRef.current) return;

    const element = threadRef.current;
    if (element === null) return;

    element.scrollTop = element.scrollHeight;
  }, [messages.length, send.isPending]);

  const onSend = async (content: string) => {
    const trimmed = content.trim();
    if (trimmed.length === 0) return;

    let targetId = conversationId;

    /*
      A conversation is created on first send, not on page load.

      Creating one when the page opens litters the sidebar with empty threads
      every time someone clicks Chat and changes their mind.
    */
    if (targetId === undefined) {
      const conversation = await create.mutateAsync(undefined);
      targetId = conversation.id;
      void navigate(buildRoute.conversation(conversation.id), { replace: true });
    }

    setDraft('');
    atBottomRef.current = true;

    const turn = await send.mutateAsync({ conversationId: targetId, content: trimmed });
    setLastTurn({ conversationId: targetId, turn });
  };

  const retryLast = () => {
    const lastQuestion = [...messages].reverse().find((message) => message.role === 'user');
    if (lastQuestion === undefined) return;

    void onSend(lastQuestion.content);
  };

  return (
    <PageContainer title="Chat" bare>
      <div className="flex min-h-0 flex-1">
        {/*
          The thread list is hidden below `lg`. On a phone the app sidebar is
          already a drawer, and a second permanent panel would leave the thread
          itself too narrow to read.
        */}
        <aside className="hidden w-64 shrink-0 border-r border-line lg:block">
          <ConversationList
            conversations={conversations.data?.items ?? []}
            activeId={conversationId}
            loading={conversations.isPending}
            busy={create.isPending}
            onSelect={(id) => { void navigate(buildRoute.conversation(id)); }}
            onCreate={() => { void navigate(ROUTES.chat); }}
            onRename={(id, title) => rename.mutate({ id, title })}
            onDelete={(id) => {
              remove.mutate(id, {
                // Leaving the user on a thread that no longer exists would
                // show them a 404 for something they just deleted.
                onSuccess: () => {
                  if (id === conversationId) void navigate(ROUTES.chat);
                },
              });
            }}
          />
        </aside>

        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={threadRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              // 32px of slack: an exact comparison is false while a smooth
              // scroll is still settling, which detaches autoscroll for no
              // reason.
              atBottomRef.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 32;
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
              {conversationId === undefined && messages.length === 0 && !send.isPending && (
                <EmptyState
                  icon={MessageSquare}
                  titleAs="h1"
                  title="Ask your documents anything"
                  description="Every answer cites the passage it came from. Add a document first if you have not already."
                  action={
                    <Button asChild variant="secondary" size="sm">
                      <Link to={ROUTES.documents}>Manage documents</Link>
                    </Button>
                  }
                />
              )}

              {thread.isPending && conversationId !== undefined && (
                <div className="space-y-4" aria-busy="true" aria-label="Loading conversation">
                  <Skeleton className="ml-auto h-10 w-1/2" />
                  <Skeleton className="h-24 w-full" />
                </div>
              )}

              {thread.isError && <Alert tone="error">{messageForError(thread.error)}</Alert>}

              {messages.map((message, index) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  // Sources are shown for the turn just answered. Historical
                  // turns keep their citations (which are persisted); the full
                  // candidate list is not, and inventing one would be a claim
                  // about what the model saw that is not true.
                  sources={
                    currentTurn?.assistantMessage.id === message.id ? currentTurn.sources : undefined
                  }
                  onRetry={
                    message.role === 'assistant' && index === messages.length - 1
                      ? retryLast
                      : undefined
                  }
                  retrying={send.isPending}
                />
              ))}

              {send.isPending && (
                <div className="space-y-2" aria-busy="true" aria-label="Generating an answer">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              )}

              {send.isError && <Alert tone="error">{messageForError(send.error)}</Alert>}
            </div>
          </div>

          <div className="border-t border-line px-4 py-3 sm:px-6">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void onSend(draft);
              }}
              className="mx-auto flex max-w-3xl items-end gap-2"
            >
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends, Shift+Enter breaks the line — the convention
                  // every chat surface uses, and the one users try first.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void onSend(draft);
                  }
                }}
                rows={1}
                maxLength={MAX_MESSAGE_LENGTH}
                placeholder="Ask a question about your documents…"
                aria-label="Your question"
                disabled={send.isPending}
                className="max-h-40 min-h-[2.5rem] flex-1 resize-none rounded-md border border-line bg-surface px-3 py-2 text-body-sm text-primary outline-none placeholder:text-tertiary focus-visible:border-focus disabled:opacity-60"
              />
              <Button type="submit" disabled={draft.trim().length === 0 || send.isPending}>
                <Send className="size-4" strokeWidth={1.5} aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">Send</span>
              </Button>
            </form>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
