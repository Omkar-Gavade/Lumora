import { useState } from 'react';
import { Search as SearchIcon, SearchX } from 'lucide-react';
import { MAX_QUERY_LENGTH } from '@lumora/shared';
import { messageForError } from '@/constants/messages';
import { PageContainer } from '@/components/layout/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSearch } from '@/features/search/hooks/useSearch';
import { SearchResult } from '@/features/search/components/SearchResult';

/**
 * The retrieval-validation page.
 *
 * docs/06-roadmap.md M4: "**The retrieval-only endpoint is the most valuable
 * debugging tool in the project.** Without it, 'the answer is wrong' is
 * unattributable between retrieval and generation." This page is the human
 * end of that tool — it exists to let someone look at what retrieval actually
 * returned, with its provenance, before any model is involved.
 *
 * Deliberately **not** a chat surface. No question framing, no answer, no
 * conversation: showing an answer here would reintroduce exactly the ambiguity
 * the page exists to remove.
 */
export function SearchPage() {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');

  const retrieval = useSearch();

  /*
    `SyntheticEvent`, not `FormEvent`: React's own types deprecate the latter
    as a name for something that does not exist in the DOM, and the linter
    enforces it.
  */
  const onSubmit = (event: React.SyntheticEvent) => {
    event.preventDefault();

    const trimmed = query.trim();
    if (trimmed.length === 0) return;

    setSubmitted(trimmed);
    retrieval.mutate({ query: trimmed });
  };

  const bundle = retrieval.data;

  /*
    Terms for highlighting, derived from what the server actually searched
    rather than from the input box.

    The two differ — normalization folds punctuation and drops a trailing
    question mark — and highlighting the raw input would mark terms the
    retriever never used.
  */
  const terms = bundle === undefined ? [] : highlightTermsFor(bundle.query);

  return (
    <PageContainer title="Search">
      <PageHeader
        title="Search"
        description="Look at what retrieval returns for a question, and where each passage came from. This is a diagnostic view — it finds evidence, it does not answer."
      />

      <form onSubmit={onSubmit} className="mt-8 flex gap-2" role="search">
        <div className="relative flex-1">
          <SearchIcon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="What does your notice period say?"
            maxLength={MAX_QUERY_LENGTH}
            aria-label="Search your documents"
            className="pl-9"
          />
        </div>
        <Button type="submit" disabled={query.trim().length === 0 || retrieval.isPending}>
          {retrieval.isPending ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {retrieval.isError && (
        <Alert tone="error" className="mt-4">
          {messageForError(retrieval.error)}
        </Alert>
      )}

      {retrieval.isPending && (
        <Card className="mt-6">
          <div className="space-y-4 p-5" aria-busy="true" aria-label="Searching">
            {[0, 1, 2].map((row) => (
              <div key={row} className="space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </div>
        </Card>
      )}

      {bundle !== undefined && !retrieval.isPending && (
        <>
          <RetrievalSummary bundle={bundle} />

          {bundle.chunks.length === 0 ? (
            <Card className="mt-4">
              <EmptyState
                icon={SearchX}
                title={
                  bundle.abstainReason === 'empty-corpus'
                    ? 'Nothing to search yet'
                    : 'No passages matched'
                }
                description={
                  /*
                    The three abstention reasons say genuinely different things
                    (docs/05-rag-and-chat.md §3.3), and collapsing them would
                    tell a new user their empty library does not contain the
                    answer.
                  */
                  bundle.abstainReason === 'empty-corpus'
                    ? 'Upload a document first — there is nothing indexed to search.'
                    : bundle.abstainReason === 'below-floor'
                      ? 'Passages were found but none were relevant enough to use as evidence.'
                      : `Nothing in your documents matched “${submitted}”.`
                }
              />
            </Card>
          ) : (
            <Card className="mt-4">
              {bundle.chunks.map((chunk, index) => (
                <SearchResult key={chunk.chunkId} chunk={chunk} rank={index + 1} terms={terms} />
              ))}
            </Card>
          )}
        </>
      )}

      {bundle === undefined && !retrieval.isPending && !retrieval.isError && (
        <Card className="mt-8">
          <EmptyState
            icon={SearchIcon}
            title="Search your documents"
            description="Ask a question and see which passages the retrieval engine would use to answer it."
          />
        </Card>
      )}
    </PageContainer>
  );
}

/**
 * The words the lexical retriever would actually have searched for.
 *
 * Postgres' `english` text-search configuration strips stop words before
 * matching, so highlighting them claims a match that never happened — and
 * "the" marked eight times in a passage buries the one word the user cares
 * about under noise.
 *
 * A short list rather than a length threshold: `and` and `the` are three
 * letters and carry nothing, while `tax`, `pay`, and `VAT` are three letters
 * and carry everything. Length is the wrong axis.
 *
 * Deliberately not the full stop-word list, and deliberately not stemmed. This
 * is a reading aid, not a second ranker — it shows the user what they asked
 * for, and over-matching would make the highlight lie in the other direction.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does', 'for', 'from', 'has',
  'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'my', 'not', 'of', 'on', 'or', 'our', 'so',
  'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

function highlightTermsFor(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

/**
 * The line of numbers under the search box.
 *
 * Every value here is one someone diagnosing retrieval asks for immediately:
 * how many each half found, how many survived, what it cost in tokens against
 * the §4.1 budget, and how long it took. Presented as one quiet line rather
 * than a dashboard — it is reference material, not the content of the page.
 */
function RetrievalSummary({
  bundle,
}: {
  bundle: NonNullable<ReturnType<typeof useSearch>['data']>;
}) {
  return (
    <p className="mt-6 text-caption tabular text-tertiary">
      {bundle.chunks.length} {bundle.chunks.length === 1 ? 'passage' : 'passages'}
      <> · {bundle.stats.vectorCandidates} semantic</>
      <> · {bundle.stats.lexicalCandidates} keyword</>
      <> · {bundle.stats.fusedCandidates} fused</>
      <>
        {' · '}
        {bundle.tokenCount}/{bundle.tokenBudget} tokens
      </>
      <> · {bundle.timings.totalMs} ms</>
    </p>
  );
}
