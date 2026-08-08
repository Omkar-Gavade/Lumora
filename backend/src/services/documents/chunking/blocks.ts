import { estimateTokens } from '../parsing/normalize.js';
import type { ParsedDocument } from '../parsing/parser.interface.js';
import type { SourceBlock } from './chunk.types.js';

/**
 * Turns a `ParsedDocument` into the structural blocks the chunker splits on.
 *
 * This is the step that recovers "strongest available boundary" from a flat
 * string plus a heading list. Everything the chunker does downstream depends on
 * getting these boundaries right — a table detected as three paragraphs is a
 * table that gets split, and a table fragment without its header row is
 * unreadable to both the model and the user (docs/05-rag-and-chat.md §2.3).
 *
 * Detection is line-oriented and deliberately conservative. A false positive
 * here fuses unrelated text into one indivisible block; a false negative only
 * costs a boundary the splitter would have liked. The asymmetry says to
 * under-detect.
 */
export function toBlocks(parsed: ParsedDocument): SourceBlock[] {
  const blocks: SourceBlock[] = [];

  /*
    Headings are matched by *containment*, not by an exact offset equality.

    The offsets parsers report point at the heading's own text, which is not
    always where its block starts: a Markdown heading's segment begins at the
    `#`, two characters earlier. An equality check silently found nothing for
    every Markdown document — no headings, no sections, no section paths, and
    the single cheapest accuracy win in the pipeline (§2.3) quietly disabled.

    Containment is correct for both shapes: DOCX reports the offset at the
    segment start, Markdown a few characters in, and both fall inside the
    segment's range.
  */
  const headings = [...parsed.headings].sort((left, right) => left.charOffset - right.charOffset);
  let headingCursor = 0;

  for (const segment of splitIntoSegments(parsed.text)) {
    // The list is sorted and segments are walked in order, so the cursor only
    // moves forward — this stays linear rather than scanning per segment.
    while (
      headingCursor < headings.length &&
      (headings[headingCursor]?.charOffset ?? 0) < segment.charStart
    ) {
      headingCursor += 1;
    }

    const candidate = headings[headingCursor];
    const heading =
      candidate !== undefined && candidate.charOffset <= segment.charEnd ? candidate : undefined;

    if (heading) {
      headingCursor += 1;
      blocks.push({
        kind: 'heading',
        text: segment.text,
        // The clean text, so a section path reads "3. Termination" rather
        // than "## 3. Termination".
        headingText: heading.text,
        level: heading.level,
        charStart: segment.charStart,
        charEnd: segment.charEnd,
        pageNumber: pageOf(parsed, segment.charStart),
      });
      continue;
    }

    blocks.push({
      kind: classify(segment.text),
      text: segment.text,
      charStart: segment.charStart,
      charEnd: segment.charEnd,
      pageNumber: pageOf(parsed, segment.charStart),
    });
  }

  return blocks;
}

interface Segment {
  text: string;
  charStart: number;
  charEnd: number;
}

/**
 * Splits normalized text into paragraph segments, tracking exact offsets.
 *
 * Offsets are carried rather than recomputed because `indexOf` on the chunk
 * text would resolve a repeated paragraph to the wrong occurrence, and
 * `char_start`/`char_end` are what make a citation point at a place rather
 * than at a document.
 *
 * A fenced code block is emitted whole even though it contains blank lines —
 * splitting inside a fence produces two fragments that are each invalid code.
 */
function splitIntoSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const lines = text.split('\n');

  let offset = 0;
  let buffer: string[] = [];
  let bufferStart = 0;
  let inFence = false;

  const flush = (endOffset: number): void => {
    const joined = buffer.join('\n').trim();
    if (joined.length > 0) {
      // Trimming shifts the start; recover it so offsets stay exact rather
      // than merely close.
      const raw = buffer.join('\n');
      const leading = raw.length - raw.trimStart().length;
      segments.push({
        text: joined,
        charStart: bufferStart + leading,
        charEnd: bufferStart + leading + joined.length,
      });
    }
    buffer = [];
    bufferStart = endOffset;
  };

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the newline consumed by `split`

    if (/^(```|~~~)/.test(line.trim())) {
      if (inFence) {
        buffer.push(line);
        inFence = false;
        flush(offset);
        continue;
      }
      // A fence opening mid-paragraph closes the paragraph first.
      flush(lineStart);
      bufferStart = lineStart;
      buffer.push(line);
      inFence = true;
      continue;
    }

    if (inFence) {
      buffer.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flush(offset);
      continue;
    }

    if (buffer.length === 0) bufferStart = lineStart;
    buffer.push(line);
  }

  flush(offset);

  return segments;
}

/** Detects the block kinds that must never be split mid-structure. */
function classify(text: string): SourceBlock['kind'] {
  if (/^(```|~~~)/.test(text)) return 'code';
  if (looksLikeTable(text)) return 'table';
  return 'paragraph';
}

/**
 * Recognises a pipe table.
 *
 * Requires **two or more** pipe-bearing lines with a consistent column count.
 * One line containing a pipe is prose about a shell command; a block of them
 * with matching arity is a table. Markdown and DOCX both surface tables this
 * way after parsing, and PDF extraction does not preserve them reliably enough
 * to detect at all — which is a known limit, not an oversight.
 */
function looksLikeTable(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 2) return false;

  const piped = lines.filter((line) => line.includes('|'));
  if (piped.length < 2 || piped.length < lines.length * 0.8) return false;

  const columns = piped.map((line) => line.split('|').length);
  return columns.every((count) => count === columns[0]) && (columns[0] ?? 0) >= 3;
}

/**
 * Finds which page a character offset came from.
 *
 * The full text is pages joined by a blank line, so page extents are
 * reconstructible by walking the same join. Linear per lookup and called once
 * per block — a binary search would be the same answer with more code at this
 * document size.
 *
 * Returns `null` for single-page (unpaginated) formats rather than `1`, so a
 * citation on a DOCX does not claim a page number the format does not have.
 */
function pageOf(parsed: ParsedDocument, charStart: number): number | null {
  if (parsed.pages.length <= 1) return null;

  let cursor = 0;
  for (const page of parsed.pages) {
    const end = cursor + page.text.length;
    if (charStart <= end) return page.pageNumber;
    cursor = end + 2; // the "\n\n" the pages were joined with
  }

  return parsed.pages.at(-1)?.pageNumber ?? null;
}

export { estimateTokens };
