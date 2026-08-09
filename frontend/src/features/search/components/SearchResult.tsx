import { FileText } from 'lucide-react';
import type { EvidenceChunkDto, RetrievalSource } from '@lumora/shared';
import { cn } from '@/lib/utils/cn';
import { Badge } from '@/components/ui/Badge';

/**
 * How each retrieval source is labelled.
 *
 * Spelled out rather than shown as `vector`/`bm25`, because the page exists to
 * let a human judge retrieval quality and "BM25" is jargon that carries no
 * meaning to anyone who has not read the architecture doc. The distinction
 * being made — did this come from meaning, or from the exact words — is the
 * one that matters when a result looks wrong.
 */
const SOURCE_LABEL: Record<RetrievalSource, string> = {
  vector: 'Semantic',
  bm25: 'Keyword',
  hybrid: 'Both',
};

/**
 * `Both` is the strongest signal in the list, so it is the only one that gets
 * colour. Two independent retrievers agreeing is better evidence than either
 * alone (docs/05-rag-and-chat.md §3.2), and the eye should find those first.
 */
const SOURCE_VARIANT: Record<RetrievalSource, 'success' | 'neutral'> = {
  vector: 'neutral',
  bm25: 'neutral',
  hybrid: 'success',
};

interface SearchResultProps {
  chunk: EvidenceChunkDto;
  /** 1-based position in the ranking. */
  rank: number;
  /** Terms from the query, already normalized and lowercased. */
  terms: string[];
}

export function SearchResult({ chunk, rank, terms }: SearchResultProps) {
  return (
    <article className="border-b border-line px-5 py-4 last:border-b-0">
      <header className="flex items-start gap-3">
        <span
          className="mt-0.5 w-5 shrink-0 text-right text-caption tabular text-tertiary"
          aria-label={`Result ${String(rank)}`}
        >
          {rank}
        </span>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-body-sm font-medium text-primary">
            <FileText className="size-3.5 shrink-0 text-tertiary" strokeWidth={1.5} aria-hidden="true" />
            <span className="truncate">{chunk.documentTitle}</span>
          </p>

          {/*
            Page and section are what turn a passage into a citation
            (docs/05-rag-and-chat.md §2.3). Both are genuinely absent for some
            formats — an unpaginated DOCX has no page — so each is rendered
            only when present rather than as "Page —", which reads as missing
            data rather than as a property the format does not have.
          */}
          <p className="mt-0.5 truncate text-caption text-tertiary">
            {chunk.pageNumber !== null && <>Page {chunk.pageNumber}</>}
            {chunk.pageNumber !== null && chunk.sectionPath !== null && <> · </>}
            {chunk.sectionPath !== null && <span>{chunk.sectionPath}</span>}
            {chunk.pageNumber === null && chunk.sectionPath === null && (
              <>Chunk {chunk.chunkIndex + 1}</>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={SOURCE_VARIANT[chunk.source]} size="sm">
            {SOURCE_LABEL[chunk.source]}
          </Badge>
        </div>
      </header>

      <p className="mt-2.5 pl-8 text-body-sm leading-relaxed text-secondary">
        <Highlighted text={chunk.text} terms={terms} />
      </p>

      {/*
        The per-retriever detail, in the smallest type on the row.

        This is the debugging payload docs/06-roadmap.md M4 asks for — "'the
        answer is wrong' is unattributable between retrieval and generation" —
        and it is deliberately quiet: it must be available when someone is
        diagnosing a bad result, and invisible when they are reading results.
      */}
      <p className="mt-2 pl-8 text-caption tabular text-tertiary">
        score {chunk.score.toFixed(4)}
        {chunk.vectorRank !== null && <> · semantic #{chunk.vectorRank}</>}
        {chunk.lexicalRank !== null && <> · keyword #{chunk.lexicalRank}</>}
        <> · {chunk.tokenCount} tokens</>
      </p>
    </article>
  );
}

/**
 * Marks query terms inside the passage.
 *
 * Case-insensitive whole-and-partial matching on the raw terms, and
 * deliberately **not** stemmed: the highlight should show what the user asked
 * for, and highlighting "terminate" for a query of "terminating" would claim a
 * match the user cannot see. The lexical retriever stems; the highlighter is
 * an honest reader, not a second ranker.
 *
 * Built with `split` on a single alternation rather than nested replacements,
 * so overlapping terms cannot produce nested markup — and rendered as React
 * nodes rather than `dangerouslySetInnerHTML`, because the text is document
 * content and a document is exactly where an injected `<script>` would come
 * from.
 */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(pattern);

  return (
    <>
      {parts.map((part, index) =>
        // `split` with a capture group puts the delimiters at odd indices.
        index % 2 === 1 ? (
          <mark
            key={index}
            className={cn(
              'rounded-xs bg-accent-subtle px-0.5 text-primary',
              // `mark` has a browser default background that ignores the
              // theme; the token is what keeps it legible in dark mode.
            )}
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { SOURCE_LABEL };
