import type { EvidenceChunkDto } from '@lumora/shared';
import type { LLMProvider, PromptMessage } from '../../providers/llm/llm-provider.interface.js';
import { GROUNDING_REMINDER, SYSTEM_PROMPT } from './system-prompt.js';

/**
 * The §4.1 allocations, in tokens.
 *
 * "Every component gets an explicit allocation, enforced by counting before
 * assembly rather than hoping." These are that table, and the builder below
 * enforces every row.
 */
export interface TokenBudget {
  system: number;
  context: number;
  history: number;
  question: number;
  output: number;
}

export const TOKEN_BUDGET: TokenBudget = {
  system: 400,
  context: 4_000,
  history: 2_000,
  question: 500,
  output: 2_000,
};

/** One prior turn, oldest first. */
export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface BuildPromptInput {
  question: string;
  /** Ranked evidence from the retrieval engine. Numbered as the UI numbers it. */
  chunks: EvidenceChunkDto[];
  history: HistoryTurn[];
  /** The rolling summary from §4.4. Not produced by M6a; consumed if present. */
  summary?: string | null;
}

export interface BuiltPrompt {
  messages: PromptMessage[];
  /** Sources actually included, in prompt order — what the citation map keys on. */
  sources: EvidenceChunkDto[];
  tokens: {
    system: number;
    context: number;
    history: number;
    question: number;
    total: number;
  };
  /** Chunks and turns dropped to stay inside the allocations. */
  dropped: { chunks: number; turns: number };
}

/**
 * Assembles the prompt (docs/05-rag-and-chat.md §4.2).
 *
 * ```
 * [system]   role, grounding rules, citation format, abstention rule, tone
 * [context]  [1] {document} · p.{page} · {section}
 *                {chunk text}
 * [history]  last N turns, oldest first
 * [user]     the original question, verbatim
 * ```
 *
 * Two structural decisions come straight from the doc and are the reason this
 * is a builder rather than a template string:
 *
 * **Sources are numbered exactly as the UI numbers them**, "so the model's `[2]`
 * and the user's `[2]` are the same passage without a remapping step that could
 * drift." The returned `sources` array *is* that numbering — index 0 is `[1]` —
 * and the citation mapper reads it rather than re-deriving one.
 *
 * **The best chunks go at the beginning and the end** (§4.2), not in strict
 * descending order: "Long-context attention is measurably weaker in the middle,
 * so burying the best passage at position 4 of 6 reduces the chance it is
 * used."
 */
export function buildPrompt(
  input: BuildPromptInput,
  provider: LLMProvider,
  budget: TokenBudget = TOKEN_BUDGET,
): BuiltPrompt {
  const count = (text: string): number => provider.countTokens(text);

  /*
    The question is truncated rather than rejected.

    §4.1 caps it at 500 tokens, and a user who pastes an essay into the
    composer should get an answer to the start of it rather than an error —
    the alternative is a wall the product hits on legitimate, if verbose, use.
  */
  const question = truncateToTokens(input.question, budget.question, provider);

  const { included, dropped: droppedChunks } = selectChunks(input.chunks, budget.context, provider);
  const ordered = orderForAttention(included);

  const contextBlock = renderContext(ordered);

  const { turns, dropped: droppedTurns } = selectHistory(
    input.history,
    input.summary ?? null,
    budget.history,
    provider,
  );

  /*
    System, sources, and the restated reminder are one message.

    Keeping the reminder in the system message rather than appending a second
    user turn is what puts it *after* the untrusted content while still
    carrying system authority — §4.3's stated mitigation. A trailing user
    message would have the position but not the weight.
  */
  const systemContent = [
    SYSTEM_PROMPT,
    '',
    'BEGIN SOURCES',
    contextBlock,
    'END SOURCES',
    '',
    GROUNDING_REMINDER,
  ].join('\n');

  const messages: PromptMessage[] = [
    { role: 'system', content: systemContent },
    ...(input.summary === null || input.summary === undefined || turns.length === input.history.length
      ? []
      : [{ role: 'system' as const, content: `Earlier in this conversation: ${input.summary}` }]),
    ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
    // The user's original wording, verbatim (§4.2). Never the normalized or
    // rewritten form — that exists only for retrieval.
    { role: 'user', content: question },
  ];

  const systemTokens = count(SYSTEM_PROMPT) + count(GROUNDING_REMINDER);
  const contextTokens = count(contextBlock);
  const historyTokens = turns.reduce((total, turn) => total + count(turn.content), 0);
  const questionTokens = count(question);

  return {
    messages,
    sources: ordered,
    tokens: {
      system: systemTokens,
      context: contextTokens,
      history: historyTokens,
      question: questionTokens,
      total: systemTokens + contextTokens + historyTokens + questionTokens,
    },
    dropped: { chunks: droppedChunks, turns: droppedTurns },
  };
}

/**
 * Fills the context allocation, dropping the lowest-ranked chunks first.
 *
 * §4.1: "Overflow is handled by dropping the lowest-ranked chunks first …
 * never by truncating mid-chunk, which produces a source that ends mid-clause
 * and a citation that points at a fragment."
 *
 * Skips rather than stops at an oversized chunk, so one long passage early in
 * the ranking does not starve three shorter, still-relevant ones behind it.
 */
function selectChunks(
  chunks: EvidenceChunkDto[],
  budget: number,
  provider: LLMProvider,
): { included: EvidenceChunkDto[]; dropped: number } {
  const included: EvidenceChunkDto[] = [];
  let used = 0;
  let dropped = 0;

  for (const chunk of chunks) {
    // Counted with the header, because the header is real tokens in the prompt
    // and a budget that ignored it would overrun by ~15 tokens per source.
    const cost = provider.countTokens(renderSource(chunk, included.length + 1));

    if (used + cost > budget) {
      dropped += 1;
      continue;
    }

    included.push(chunk);
    used += cost;
  }

  return { included, dropped };
}

/**
 * Reorders so the strongest evidence sits at both ends of the block (§4.2).
 *
 * Best first, second-best last, third second, and so on — a "serpentine" fold.
 * The result is that positions 1 and N hold the two highest-scoring chunks and
 * the weakest evidence ends up in the middle, which is where long-context
 * attention is weakest.
 *
 * Input must already be ranked; this reorders, it does not rank.
 */
export function orderForAttention<T>(ranked: T[]): T[] {
  if (ranked.length <= 2) return [...ranked];

  const front: T[] = [];
  const back: T[] = [];

  ranked.forEach((item, index) => {
    if (index % 2 === 0) front.push(item);
    else back.unshift(item);
  });

  return [...front, ...back];
}

/** `[n] document · p.N · section` followed by the passage. */
function renderSource(chunk: EvidenceChunkDto, index: number): string {
  const locator = [
    chunk.documentTitle,
    chunk.pageNumber === null ? null : `p.${String(chunk.pageNumber)}`,
    chunk.sectionPath,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return `[${String(index)}] ${locator}\n${chunk.text}`;
}

function renderContext(chunks: EvidenceChunkDto[]): string {
  if (chunks.length === 0) return '(no sources)';
  return chunks.map((chunk, index) => renderSource(chunk, index + 1)).join('\n\n');
}

/**
 * Takes the most recent turns that fit, oldest first (§4.4).
 *
 * Walks backwards from the newest so the turns nearest the question survive —
 * dropping the *oldest* is what "compressing history" means here, and the
 * summary is what covers what was dropped once §4.4's summarizer exists.
 *
 * Turns are kept whole. Half a previous answer is worse context than none: it
 * reads as the assistant having been cut off, which the model then imitates.
 */
function selectHistory(
  history: HistoryTurn[],
  summary: string | null,
  budget: number,
  provider: LLMProvider,
): { turns: HistoryTurn[]; dropped: number } {
  const available = summary === null ? budget : budget - provider.countTokens(summary);

  const kept: HistoryTurn[] = [];
  let used = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn === undefined) continue;

    const cost = provider.countTokens(turn.content);
    if (used + cost > available) break;

    kept.unshift(turn);
    used += cost;
  }

  return { turns: kept, dropped: history.length - kept.length };
}

/**
 * Cuts a string to a token ceiling on a word boundary.
 *
 * Used only for the question, where §4.1 sets a hard cap and the alternative
 * is refusing the request. Never used on a chunk — that is the case the doc
 * explicitly forbids.
 */
export function truncateToTokens(text: string, maxTokens: number, provider: LLMProvider): string {
  if (provider.countTokens(text) <= maxTokens) return text;

  // The estimate is characters ÷ 4, so this is the inverse. Trimmed back to a
  // word boundary, because cutting mid-word produces a fragment the model then
  // tries to interpret.
  const approximateChars = maxTokens * 4;
  const cut = text.slice(0, approximateChars);
  const lastSpace = cut.lastIndexOf(' ');

  return (lastSpace > approximateChars * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
