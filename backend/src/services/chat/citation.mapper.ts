import type { EvidenceChunkDto } from '@lumora/shared';

/** A citation ready to persist, with the cited text frozen at answer time. */
export interface MappedCitation {
  /** The `[n]` the user sees. 1-based, matching the prompt's numbering. */
  citationIndex: number;
  chunkId: string;
  documentId: string;
  score: number;
  /** docs/04 §1.1: survives the document's deletion so past answers stay verifiable. */
  contentSnapshot: string;
}

export interface CitationResult {
  /** The answer with unusable markers removed. */
  content: string;
  /** Only the sources the model actually cited, in first-appearance order. */
  citations: MappedCitation[];
  /** Markers that referenced no source. A quality signal, not an error. */
  invalidMarkers: number[];
}

/**
 * Validates and maps the `[n]` markers in a generated answer
 * (docs/05-rag-and-chat.md §5, defence 3).
 *
 * "After generation, every `[n]` in the output is checked against the retrieved
 * set. Out-of-range markers are stripped before display and logged as a quality
 * signal. **A citation the user can click and find empty is worse than no
 * citation.**"
 *
 * Three things happen here, and each is one of §5's five defences:
 *
 * - **Validation.** A marker outside `1..sources.length` cites nothing. It is
 *   removed from the text rather than rendered as a dead chip.
 * - **Snapshot.** The cited chunk's text is copied onto the citation, so the
 *   answer stays verifiable after the document is deleted (defence 4).
 * - **Mapping.** Only cited sources become citations. A source the model
 *   ignored is not evidence for the answer, and listing all six under an answer
 *   that used two is a claim about grounding that is not true.
 *
 * Numbering is **not** renormalized. The prompt numbered sources 1..N and §4.2
 * requires "the model's `[2]` and the user's `[2]` are the same passage without
 * a remapping step that could drift" — renumbering after the fact is exactly
 * that remapping step.
 */
export function mapCitations(content: string, sources: EvidenceChunkDto[]): CitationResult {
  const seen = new Map<number, MappedCitation>();
  const invalid = new Set<number>();

  for (const match of content.matchAll(CITATION_PATTERN)) {
    const index = Number(match[1]);

    const source = sources[index - 1];
    if (source === undefined) {
      invalid.add(index);
      continue;
    }

    if (!seen.has(index)) {
      seen.set(index, {
        citationIndex: index,
        chunkId: source.chunkId,
        documentId: source.documentId,
        score: source.score,
        contentSnapshot: source.text,
      });
    }
  }

  return {
    content: invalid.size === 0 ? content : stripMarkers(content, invalid),
    // Ascending, so `[1]` precedes `[2]` in the sources panel regardless of the
    // order the model happened to cite them in.
    citations: [...seen.values()].sort((left, right) => left.citationIndex - right.citationIndex),
    invalidMarkers: [...invalid].sort((left, right) => left - right),
  };
}

/**
 * Matches `[1]`, `[12]` — and nothing else.
 *
 * Deliberately narrow. Markdown links (`[text](url)`), footnote syntax
 * (`[^1]`), and array indexing in a code block (`items[0]`) all look like
 * citations to a looser pattern, and stripping one out of a code block
 * corrupts the answer. Requiring the brackets to contain only digits, with a
 * leading digit that is not zero, excludes all three.
 */
const CITATION_PATTERN = /\[([1-9]\d{0,2})]/g;

/**
 * Removes markers that cite nothing, and tidies the space they leave.
 *
 * "Revenue grew 12% [7]." must not become "Revenue grew 12% ." — a stranded
 * space before punctuation reads as a typo and draws the eye to the exact spot
 * something was removed.
 */
function stripMarkers(content: string, invalid: Set<number>): string {
  return content
    .replace(CITATION_PATTERN, (marker, digits: string) =>
      invalid.has(Number(digits)) ? '' : marker,
    )
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .replace(/[ \t]+$/gm, '');
}

/**
 * Whether an answer cited anything at all.
 *
 * Used as a quality signal rather than a gate: an answer with sources and no
 * citations is either an abstention phrased conversationally or a model
 * ignoring rule 2, and both are worth counting. Blocking it would turn a
 * degraded answer into no answer.
 */
export function isUncited(result: CitationResult, sources: EvidenceChunkDto[]): boolean {
  return sources.length > 0 && result.citations.length === 0;
}
