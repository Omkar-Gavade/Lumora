import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, MessageSquare, Send, Square } from 'lucide-react';
import { MAX_MESSAGE_LENGTH } from '@lumora/shared';
import { ROUTES, buildRoute } from '@/app/router/routes';
import { messageForError } from '@/constants/messages';
import { PageContainer } from '@/components/layout/PageContainer';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Skeleton } from '@/components/ui/Skeleton';
import { ConversationScope } from '@/features/chat/components/ConversationScope';
import { MessageBubble } from '@/features/chat/components/MessageBubble';
import { StreamingMessage } from '@/features/chat/components/StreamingMessage';
import { useStreamingTurn } from '@/features/chat/hooks/useStreamingTurn';
import { useConversation, useCreateConversation } from '@/features/chat/hooks/useChat';

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

  const thread = useConversation(conversationId);
  const create = useCreateConversation();
  const stream = useStreamingTurn();

  const [draft, setDraft] = useState('');
  /** Set when the user scrolls up mid-stream — see the pill below. */
  const [detached, setDetached] = useState(false);
  /*
    The live turn is shown only on the thread it belongs to.

    Switching conversations mid-stream must not paint the previous thread's
    tokens into the new one — the generation keeps running on the server (and
    is still persisted), but this view stops claiming it belongs here.
  */
  const liveTurn = stream.streamingFor === conversationId ? stream.turn : null;

  /*
    The live turn and the persisted thread must never both be on screen.

    While generating, the thread's own rows are a `pending` placeholder with no
    text, so the live turn is the only thing worth showing. Once `done` lands
    the thread refetches and becomes the source of truth — but the refetch is
    not instant, and dropping the live turn the moment the stream ends would
    blank the answer for a frame. Holding it until the refetch settles closes
    that gap without ever rendering the answer twice.
  */
  const showLiveTurn = liveTurn !== null && (stream.isStreaming || thread.isFetching);

  const threadRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  /*
    Placeholders are filtered out: an assistant row that is still `pending` or
    `streaming` has no text, and rendering it beside the live turn would show
    an empty bubble under the answer being written.
  */
  const messages = (thread.data?.messages ?? []).filter(
    (message) => message.status !== 'pending' && message.status !== 'streaming',
  );

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
  }, [messages.length, liveTurn?.text, stream.isStreaming]);

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
    setDetached(false);

    await stream.start({ conversationId: targetId, content: trimmed });
  };

  /** Re-asks the last question — the Retry in §8.3's failed and stopped states. */
  const retryLast = () => {
    const lastQuestion = [...messages].reverse().find((message) => message.role === 'user');
    if (lastQuestion === undefined) return;

    void onSend(lastQuestion.content);
  };

  /**
   * Asks for a different answer to the same question (§7 regeneration).
   *
   * Distinct from retry: retry re-sends the question as a new turn, regenerate
   * replaces one answer while keeping its lineage. Offered on the last
   * assistant turn, matching docs/00-product.md §8.3.
   */
  const regenerate = (messageId: string) => {
    if (conversationId === undefined) return;

    atBottomRef.current = true;
    setDetached(false);
    void stream.start({ conversationId, content: '', regenerateFrom: messageId });
  };

  const stopGenerating = () => {
    if (conversationId !== undefined) stream.stop(conversationId);
  };

  return (
    <PageContainer title="Chat" bare>
      {/*
        One column. The conversation list lives in the app sidebar now
        (docs/00-product.md FR-21) rather than in a second panel here — which
        is what lets the thread have the whole width on a phone, and what
        stops there being two conversation lists to keep in sync.
      */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Names the knowledge base this thread answers from, when it has
              one. Renders nothing for an unscoped conversation. */}
          <ConversationScope knowledgeBaseId={thread.data?.conversation.knowledgeBaseId} />

          <div
            ref={threadRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              /*
                §8.3: "follow the stream only while the viewport is within
                100px of the bottom. The moment the user scrolls up, autoscroll
                detaches and a 'Jump to latest ↓' pill appears. Autoscroll
                never yanks the viewport away from something being read."
              */
              const atBottom =
                element.scrollHeight - element.scrollTop - element.clientHeight < 100;

              atBottomRef.current = atBottom;
              setDetached(!atBottom);
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
              {conversationId === undefined && messages.length === 0 && liveTurn === null && (
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
                  onRetry={
                    message.role === 'assistant' && index === messages.length - 1
                      ? message.status === 'failed'
                        ? retryLast
                        : () => regenerate(message.id)
                      : undefined
                  }
                  retrying={stream.isStreaming}
                />
              ))}

              {showLiveTurn && liveTurn !== null && (
                <>
                  {/*
                    The optimistic question, echoed before the server confirms
                    it. A regenerate has no new question, so it is omitted.
                  */}
                  {liveTurn.question.length > 0 && (
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-lg bg-inset px-3.5 py-2.5 text-body-sm text-primary">
                        <p className="whitespace-pre-wrap break-words">{liveTurn.question}</p>
                      </div>
                    </div>
                  )}

                  <StreamingMessage
                    text={liveTurn.text}
                    phase={liveTurn.phase}
                    sourceCount={liveTurn.sources.length}
                    streaming={stream.isStreaming}
                  />

                  {/*
                    §8.3: "Stopped by user: partial answer persisted with a
                    subtle 'Stopped' label."
                  */}
                  {liveTurn.finishReason === 'aborted' && (
                    <p className="text-caption text-tertiary">Stopped</p>
                  )}

                  {liveTurn.error !== null && (
                    <Alert tone="error">
                      {liveTurn.error}{' '}
                      <button
                        type="button"
                        onClick={retryLast}
                        className="cursor-pointer underline underline-offset-2"
                      >
                        Retry
                      </button>
                    </Alert>
                  )}
                </>
              )}
            </div>
          </div>

          {/*
            The detach pill. Only while a stream is live — on a settled thread
            the scrollbar already says where you are.
          */}
          {detached && stream.isStreaming && (
            <div className="pointer-events-none relative">
              <button
                type="button"
                onClick={() => {
                  atBottomRef.current = true;
                  setDetached(false);
                  const element = threadRef.current;
                  if (element !== null) element.scrollTop = element.scrollHeight;
                }}
                className="pointer-events-auto absolute -top-12 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-caption text-secondary shadow-sm hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <ArrowDown className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
                Jump to latest
              </button>
            </div>
          )}

          {/* `pb-safe` clears the iOS home indicator, which otherwise sits on
              top of the send button on every notched phone. */}
          <div className="border-t border-line px-4 pt-3 pb-safe sm:px-6">
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
                  /*
                    §8.3: "`⌘↵`/`Enter` sends (Enter-to-send with `Shift+Enter`
                    for newline — the chat convention)."

                    Escape stops a live generation, so the most common thing a
                    user wants mid-stream is one key away rather than a mouse
                    trip to the button.
                  */
                  if (event.key === 'Escape' && stream.isStreaming) {
                    event.preventDefault();
                    stopGenerating();
                    return;
                  }

                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void onSend(draft);
                  }
                }}
                rows={1}
                maxLength={MAX_MESSAGE_LENGTH}
                /*
                  Shorter than the sentence this used to be, because at the
                  touch font size below it wrapped to a second line inside a
                  one-line field and the tail was clipped. A placeholder that
                  cannot be read whole is worse than a terse one.
                */
                placeholder="Ask about your documents…"
                aria-label="Your question"
                /*
                  16px on touch, 14px once there is a pointer.

                  Not a design change — a Safari one. iOS zooms the viewport
                  when a focused field's text is under 16px, and the zoom
                  neither reverts on blur nor respects the layout: the composer
                  ends up half off-screen the moment the keyboard opens. Both
                  steps are existing tokens, and the desktop size is unchanged.

                  The touch minimum height goes to 44px for the same reason the
                  sidebar rows do; the desktop 40px is untouched.
                */
                className="max-h-40 min-h-11 flex-1 resize-none rounded-md border border-line bg-surface px-3 py-2 text-body text-primary outline-none placeholder:text-tertiary focus-visible:border-focus md:min-h-[2.5rem] md:text-body-sm"
              />

              {/*
                §8.3: "a send button that becomes a stop button during
                generation." One control, because a separate stop button is
                dead weight for the 99% of the time nothing is generating — and
                the thing a user reaches for mid-stream is exactly where they
                just clicked send.
              */}
              {stream.isStreaming ? (
                <Button type="button" variant="secondary" onClick={stopGenerating}>
                  <Square className="size-3.5 fill-current" strokeWidth={1.5} aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">Stop</span>
                </Button>
              ) : (
                <Button type="submit" disabled={draft.trim().length === 0}>
                  <Send className="size-4" strokeWidth={1.5} aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">Send</span>
                </Button>
              )}
            </form>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
