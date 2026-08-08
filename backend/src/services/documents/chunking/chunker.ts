import { estimateTokens } from '../parsing/normalize.js';
import type { ParsedDocument } from '../parsing/parser.interface.js';
import { toBlocks } from './blocks.js';
import {
  DEFAULT_CHUNK_OPTIONS,
  type Chunk,
  type ChunkOptions,
  type SourceBlock,
} from './chunk.types.js';

/**
 * Recursive structure-aware chunking (docs/05-rag-and-chat.md §2.3).
 *
 * "The highest-leverage decision in the whole system. Retrieval quality is
 * bounded by chunk quality — no reranker recovers from a chunk that splits a
 * sentence away from its subject."
 *
 * The strategy is one sentence: **split on the strongest available boundary
 * first, and only descend when a piece is still too large.** Section heading →
 * paragraph → sentence → token window. Descending is a cost, not a goal: every
 * level down loses context the level above was carrying.
 *
 * **Deterministic by construction.** A pure function of `(parsed document,
 * options)` — no clock, no randomness, no identifier generation. That is what
 * makes a retry after a partial embedding run produce byte-identical chunks,
 * which is in turn what makes upserting on `(document_id, chunk_index)` a
 * no-op rather than a silent rewrite of text whose vectors were already paid
 * for.
 */
export function chunkDocument(
  parsed: ParsedDocument,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  const blocks = toBlocks(parsed);
  const sections = groupIntoSections(blocks);

  const draft: DraftChunk[] = [];
  for (const section of sections) {
    draft.push(...chunkSection(section, options));
  }

  const merged = mergeUndersized(draft, options);
  const overlapped = applyOverlap(merged, options);

  return overlapped.map((chunk, index) => ({
    index,
    content: chunk.content,
    // Contextual enrichment, applied last so it can never affect a size
    // decision — a chunk must not be split because its section path is long.
    embedText: chunk.sectionPath === null ? chunk.content : `${chunk.sectionPath}\n\n${chunk.content}`,
    tokenCount: estimateTokens(chunk.content),
    pageNumber: chunk.pageNumber,
    sectionPath: chunk.sectionPath,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
  }));
}

interface DraftChunk {
  content: string;
  pageNumber: number | null;
  sectionPath: string | null;
  charStart: number;
  charEnd: number;
}

interface Section {
  /** `["3. Termination", "3.2 Notice"]` — the heading stack at this point. */
  path: string[];
  blocks: SourceBlock[];
}

/**
 * Groups blocks under the heading stack in force at each point.
 *
 * A stack rather than a flat "last heading seen": an `h3` under an `h2` under
 * an `h1` is three levels of context, and reporting only the nearest one gives
 * a chunk labelled "3.2 Notice" with nothing saying what document or clause
 * that belongs to. Popping to the incoming level is what keeps a later `h2`
 * from inheriting the previous `h2`'s subsections.
 */
function groupIntoSections(blocks: SourceBlock[]): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let current: Section = { path: [], blocks: [] };

  for (const block of blocks) {
    if (block.kind === 'heading') {
      const level = block.level ?? 1;
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, text: block.headingText ?? block.text });

      /*
        A section with no content of its own is carried forward rather than
        emitted.

        `# Agreement` immediately followed by `## Termination` is the ordinary
        shape of a structured document, and closing the first section there
        would emit a chunk containing nothing but the words "# Agreement".
        That chunk cannot be merged away either — the minimum-size rule only
        merges within a section, and by construction these two have different
        paths. The result is a permanent noise chunk that matches
        heading-shaped queries and answers nothing.

        Carrying the heading into the section it introduces is also the more
        faithful reading: the heading is context for the text beneath it, not a
        passage in its own right.
      */
      const hasContent = current.blocks.some((entry) => entry.kind !== 'heading');
      const carried = hasContent ? [] : current.blocks;
      if (hasContent) sections.push(current);

      current = { path: stack.map((entry) => entry.text), blocks: [...carried, block] };
      continue;
    }

    current.blocks.push(block);
  }

  if (current.blocks.length > 0) sections.push(current);

  return sections;
}

/** Packs a section's blocks into chunks, descending only when forced. */
function chunkSection(section: Section, options: ChunkOptions): DraftChunk[] {
  const sectionPath = section.path.length > 0 ? section.path.join(' > ') : null;
  const chunks: DraftChunk[] = [];

  let buffer: SourceBlock[] = [];
  let bufferTokens = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    chunks.push(fromBlocks(buffer, sectionPath));
    buffer = [];
    bufferTokens = 0;
  };

  for (const block of section.blocks) {
    const blockTokens = estimateTokens(block.text);

    if (blockTokens > options.maxTokens) {
      // Too large to pack whole: emit what is buffered, then descend into it.
      flush();
      chunks.push(...splitOversizedBlock(block, sectionPath, options));
      continue;
    }

    // Packing past the target is what keeps chunks near 512 instead of
    // averaging half that — a paragraph that would take the buffer over the
    // target starts the next chunk instead of being crammed in.
    if (bufferTokens > 0 && bufferTokens + blockTokens > options.targetTokens) flush();

    buffer.push(block);
    bufferTokens += blockTokens;
  }

  flush();

  return chunks;
}

/**
 * Descends into a block that exceeds the hard maximum.
 *
 * Each kind descends differently because each has a different structure worth
 * not destroying — the whole reason blocks are typed.
 */
function splitOversizedBlock(
  block: SourceBlock,
  sectionPath: string | null,
  options: ChunkOptions,
): DraftChunk[] {
  if (block.kind === 'table') return splitTable(block, sectionPath, options);
  if (block.kind === 'code') return splitByLines(block, sectionPath, options);
  return splitBySentences(block, sectionPath, options);
}

/**
 * Splits a table by rows, **repeating the header row into every part**.
 *
 * docs §2.3: "a table fragment without its header is unreadable to both the
 * model and the user". A row reading `| 4 | 12 | 2019 |` with no header is
 * noise in the index and a citation that explains nothing.
 */
function splitTable(
  block: SourceBlock,
  sectionPath: string | null,
  options: ChunkOptions,
): DraftChunk[] {
  const lines = block.text.split('\n');
  const header = lines[0] ?? '';
  // A markdown alignment row (`|---|---|`) is part of the header, not data.
  const separator = lines[1] !== undefined && /^[\s|:-]+$/.test(lines[1]) ? lines[1] : null;
  const headerLines = separator === null ? [header] : [header, separator];
  const bodyLines = lines.slice(headerLines.length);

  const headerTokens = estimateTokens(headerLines.join('\n'));
  const chunks: DraftChunk[] = [];

  let buffer: string[] = [];
  let tokens = headerTokens;
  let offset = block.charStart + headerLines.join('\n').length + 1;
  let chunkStart = offset;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const body = buffer.join('\n');
    chunks.push({
      content: [...headerLines, body].join('\n'),
      pageNumber: block.pageNumber,
      sectionPath,
      charStart: chunkStart,
      charEnd: chunkStart + body.length,
    });
    buffer = [];
    tokens = headerTokens;
  };

  for (const line of bodyLines) {
    const lineTokens = estimateTokens(line);
    if (buffer.length > 0 && tokens + lineTokens > options.maxTokens) {
      flush();
      chunkStart = offset;
    }
    buffer.push(line);
    tokens += lineTokens;
    offset += line.length + 1;
  }

  flush();

  return chunks;
}

/**
 * Splits on line boundaries — the fallback for code.
 *
 * A code block over the maximum has to be split somewhere, and a line is the
 * only boundary in code that is never mid-token. Splitting on characters would
 * cut an identifier in half and index a fragment matching nothing.
 */
function splitByLines(
  block: SourceBlock,
  sectionPath: string | null,
  options: ChunkOptions,
): DraftChunk[] {
  return packPieces(
    block.text.split('\n').map((line) => `${line}\n`),
    block,
    sectionPath,
    options,
  );
}

/**
 * Splits on sentence boundaries — the normal descent for prose.
 *
 * §2.3's first rule: "Never split mid-sentence." A chunk ending "the notice
 * period shall be" is unusable to a reader and embeds to something between the
 * two ideas it straddles.
 */
function splitBySentences(
  block: SourceBlock,
  sectionPath: string | null,
  options: ChunkOptions,
): DraftChunk[] {
  const sentences = splitSentences(block.text);
  const packed = packPieces(sentences, block, sectionPath, options);

  /*
    A single sentence over the hard maximum is the one case where the sentence
    rule cannot hold — a 900-token sentence exists (a legal enumeration, a
    generated list) and refusing to split it would emit a chunk the embedder
    truncates silently. Falling back to a word window is the honest failure:
    the boundary is wrong, but every word is present exactly once.
  */
  return packed.flatMap((chunk) =>
    estimateTokens(chunk.content) <= options.maxTokens
      ? [chunk]
      : splitByWordWindow(chunk, options),
  );
}

/** Greedy packing of pieces into chunks, preserving exact offsets. */
function packPieces(
  pieces: string[],
  block: SourceBlock,
  sectionPath: string | null,
  options: ChunkOptions,
): DraftChunk[] {
  const chunks: DraftChunk[] = [];

  let buffer: string[] = [];
  let tokens = 0;
  let offset = block.charStart;
  let chunkStart = block.charStart;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const content = buffer.join('').trim();
    if (content.length > 0) {
      chunks.push({
        content,
        pageNumber: block.pageNumber,
        sectionPath,
        charStart: chunkStart,
        charEnd: chunkStart + content.length,
      });
    }
    buffer = [];
    tokens = 0;
  };

  for (const piece of pieces) {
    const pieceTokens = estimateTokens(piece);

    if (buffer.length > 0 && tokens + pieceTokens > options.targetTokens) {
      flush();
      chunkStart = offset;
    }

    buffer.push(piece);
    tokens += pieceTokens;
    offset += piece.length;
  }

  flush();

  return chunks;
}

/** Last resort: a fixed word window. Only reached by a single oversized sentence. */
function splitByWordWindow(chunk: DraftChunk, options: ChunkOptions): DraftChunk[] {
  const words = chunk.content.split(' ');
  // Four characters per token is the same approximation `estimateTokens` uses,
  // so the window lands where the token estimate expects it to.
  const wordsPerChunk = Math.max(1, Math.floor((options.targetTokens * 4) / 6));

  const parts: DraftChunk[] = [];
  let cursor = chunk.charStart;

  for (let index = 0; index < words.length; index += wordsPerChunk) {
    const content = words.slice(index, index + wordsPerChunk).join(' ');
    parts.push({ ...chunk, content, charStart: cursor, charEnd: cursor + content.length });
    cursor += content.length + 1;
  }

  return parts;
}

/**
 * Sentence segmentation.
 *
 * Splits after `.`/`!`/`?` followed by whitespace and something that starts a
 * sentence, with common abbreviations held back. Not a trained segmenter —
 * that is a dependency and a model — and it does not need to be: an occasional
 * split after "Fig. 3" costs one imperfect boundary, while the cases this does
 * catch (every ordinary sentence end) are what the rule exists for.
 */
const ABBREVIATIONS =
  /\b(?:[A-Z]|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Inc|Ltd|Co|Corp|vs|etc|e\.g|i\.e|approx|Fig|No|Vol|pp|Sec|Art)\.$/;

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;

  // Boundary candidates: terminator, then whitespace, then a capital, a digit,
  // or an opening quote/bracket.
  const boundary = /([.!?]["')\]]?)\s+(?=[A-Z0-9"'([])/g;
  let match: RegExpExecArray | null;

  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const candidate = text.slice(start, match.index + (match[1]?.length ?? 0));

    if (ABBREVIATIONS.test(candidate.trimEnd())) continue;

    sentences.push(text.slice(start, end));
    start = end;
  }

  if (start < text.length) sentences.push(text.slice(start));

  return sentences.length > 0 ? sentences : [text];
}

/** Joins consecutive blocks into one chunk, carrying the outermost offsets. */
function fromBlocks(blocks: SourceBlock[], sectionPath: string | null): DraftChunk {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];

  return {
    content: blocks.map((block) => block.text).join('\n\n'),
    // The page a chunk *starts* on. A chunk spanning a page break cites where
    // its text begins, which is where a reader opening the citation should
    // land.
    pageNumber: first?.pageNumber ?? null,
    sectionPath,
    charStart: first?.charStart ?? 0,
    charEnd: last?.charEnd ?? 0,
  };
}

/**
 * Merges chunks below the minimum into a neighbour.
 *
 * §2.3: "Chunks below the minimum are merged with a neighbor rather than
 * indexed as noise." A 20-token chunk reading "See Appendix B." is retrievable,
 * ranks on the word "appendix", and answers nothing.
 *
 * Merges backward, into the preceding chunk, so the fragment keeps the context
 * that led to it. A trailing fragment with no predecessor merges forward
 * instead of being dropped — dropping is data loss, and the fragment may be the
 * only place a fact appears.
 *
 * Only merges within the same section: fusing the last paragraph of
 * "3.1 Scope" into "3.2 Notice" would give the combined chunk a section path
 * that is wrong for half its text.
 */
function mergeUndersized(chunks: DraftChunk[], options: ChunkOptions): DraftChunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: DraftChunk[] = [];

  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    const undersized = estimateTokens(chunk.content) < options.minTokens;

    const canMergeBack =
      previous?.sectionPath === chunk.sectionPath &&
      estimateTokens(previous.content) + estimateTokens(chunk.content) <= options.maxTokens;

    if (undersized && canMergeBack) {
      merged[merged.length - 1] = {
        ...previous,
        content: `${previous.content}\n\n${chunk.content}`,
        charEnd: chunk.charEnd,
      };
      continue;
    }

    merged.push(chunk);
  }

  // A lone trailing fragment that could not merge backward (different section,
  // or would breach the maximum) is kept rather than discarded.
  return merged;
}

/**
 * Carries the tail of each chunk into the next, on sentence boundaries.
 *
 * §2.3: overlap "exists so a fact spanning a boundary is fully present in at
 * least one chunk". Without it, a sentence whose subject is in chunk *n* and
 * whose predicate is in chunk *n+1* is retrievable by neither.
 *
 * Applied to `content`, which means the overlapped text is what a citation
 * shows — correct, because the overlap is genuinely part of the passage's
 * context, not padding.
 *
 * Only within a section, and never from a chunk in a different section: a
 * paragraph about termination prefixed to a chunk about compensation makes both
 * chunks slightly about the wrong thing.
 */
function applyOverlap(chunks: DraftChunk[], options: ChunkOptions): DraftChunk[] {
  if (options.overlapTokens <= 0) return chunks;

  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;

    const previous = chunks[index - 1];
    if (previous?.sectionPath !== chunk.sectionPath) return chunk;

    const tail = takeTailSentences(previous.content, options.overlapTokens);
    if (tail.length === 0) return chunk;

    return {
      ...chunk,
      content: `${tail}\n\n${chunk.content}`,
      // `charStart` still points at this chunk's own text. The overlap is
      // borrowed context, and a citation offset that walked backward into the
      // previous chunk would highlight the wrong span in the source document.
    };
  });
}

/** The last whole sentences of `text` fitting inside `budget` tokens. */
function takeTailSentences(text: string, budget: number): string {
  const sentences = splitSentences(text);
  const taken: string[] = [];
  let tokens = 0;

  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index] ?? '';
    const cost = estimateTokens(sentence);
    // Never partial: half a sentence as overlap reintroduces exactly the
    // mid-sentence split the strategy exists to avoid.
    if (tokens + cost > budget) break;
    taken.unshift(sentence);
    tokens += cost;
  }

  return taken.join('').trim();
}

export { DEFAULT_CHUNK_OPTIONS };
