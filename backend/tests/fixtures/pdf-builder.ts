/**
 * Builds real, structurally valid PDFs in memory.
 *
 * The alternative was checking binary fixtures into the repository, and this is
 * better on the axis that matters here: a test that says "a two-page PDF
 * containing this sentence" can be read and believed, whereas
 * `two-page-sample.pdf` is an opaque blob nobody can verify without opening it
 * in another program. It is also the only practical way to build the negative
 * cases — a PDF with pages and no text layer is not a file you can casually
 * obtain, but it is three lines here.
 *
 * These are genuine PDFs, not stubs. They carry a correct cross-reference
 * table with byte-accurate offsets, which is precisely what pdfjs reads first
 * and what an approximation would fail on.
 */

interface PdfObject {
  /** Body between `N 0 obj` and `endobj`. */
  body: string;
  /** Raw stream bytes, when the object is a stream. */
  stream?: string;
}

/**
 * Assembles numbered objects into a file with a valid xref table.
 *
 * The offsets are the whole reason this is a function rather than a template
 * string: every entry is the absolute byte position of its object, so any
 * change to any earlier object shifts all of them. Computing them from the
 * buffer as it is built is what keeps that correct by construction.
 */
function assemble(objects: PdfObject[]): Buffer {
  const header = '%PDF-1.4\n';
  const chunks: string[] = [header];
  const offsets: number[] = [];
  let position = header.length;

  objects.forEach((object, index) => {
    offsets.push(position);

    const serialized =
      object.stream === undefined
        ? `${String(index + 1)} 0 obj\n${object.body}\nendobj\n`
        : `${String(index + 1)} 0 obj\n${object.body}\nstream\n${object.stream}\nendstream\nendobj\n`;

    chunks.push(serialized);
    // latin1: one byte per code unit, so string length equals byte length and
    // the offsets below are exact. Every construct here is ASCII.
    position += Buffer.byteLength(serialized, 'latin1');
  });

  const xrefOffset = position;
  const entries = offsets
    // 10-digit offset, 5-digit generation, `n` — the fixed-width format the
    // spec requires. A mis-padded entry makes the table unreadable.
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');

  const trailer =
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${entries}` +
    `trailer\n<</Size ${String(objects.length + 1)}/Root 1 0 R>>\n` +
    `startxref\n${String(xrefOffset)}\n%%EOF\n`;

  chunks.push(trailer);

  return Buffer.from(chunks.join(''), 'latin1');
}

/** Escapes the three characters that terminate a PDF literal string. */
function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Renders lines of text as a content stream.
 *
 * Each line gets its own positioning operator with a downward offset, which is
 * what makes pdfjs report a line break — it derives `hasEOL` from the vertical
 * transform, not from anything in the text itself. Emitting one long `Tj`
 * would produce a single run with no line structure, and the extraction path
 * being tested is specifically the one that reassembles lines.
 */
function contentStream(lines: string[]): string {
  const body = lines
    .map((line, index) => `BT /F1 12 Tf 72 ${String(720 - index * 16)} Td (${escapeText(line)}) Tj ET`)
    .join('\n');
  return body;
}

export interface PdfOptions {
  /** One entry per page; each entry is that page's lines. */
  pages: string[][];
}

/**
 * A PDF with the given pages.
 *
 * Object numbering: 1 catalog, 2 page tree, 3 font, then a `(page, content)`
 * pair per page. Fixed, so the references below can be written literally
 * instead of tracked.
 */
export function buildPdf(options: PdfOptions): Buffer {
  const pageCount = options.pages.length;

  // Pages start at object 4 and alternate page/content, so page *i* is object
  // `4 + i*2` and its content stream is the one after it.
  const pageObjectNumber = (index: number): number => 4 + index * 2;

  const kids = options.pages
    .map((_, index) => `${String(pageObjectNumber(index))} 0 R`)
    .join(' ');

  const objects: PdfObject[] = [
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: `<</Type/Pages/Kids[${kids}]/Count ${String(pageCount)}>>` },
    { body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' },
  ];

  options.pages.forEach((lines, index) => {
    const contentNumber = pageObjectNumber(index) + 1;
    const stream = contentStream(lines);

    objects.push({
      body:
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]` +
        `/Resources<</Font<</F1 3 0 R>>>>/Contents ${String(contentNumber)} 0 R>>`,
    });
    objects.push({
      body: `<</Length ${String(Buffer.byteLength(stream, 'latin1'))}>>`,
      stream,
    });
  });

  return assemble(objects);
}

/**
 * A PDF with pages and no text at all — a scan, as far as extraction can tell.
 *
 * The case `NO_TEXT_LAYER` exists for. Real scanned PDFs carry an image XObject
 * per page; the image is irrelevant to the check, which only ever asks how much
 * text came out, so pages with empty content streams reproduce the condition
 * exactly without embedding a JPEG in a source file.
 */
export function buildTextlessPdf(pageCount: number): Buffer {
  return buildPdf({ pages: Array.from({ length: pageCount }, () => []) });
}

/**
 * Bytes that start like a PDF and are not one.
 *
 * A valid header with a corrupt body, because that is the realistic failure —
 * a truncated upload or a damaged file. Bytes that fail at the header would be
 * rejected by upload validation long before a parser saw them.
 */
export function buildCorruptPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer\n%%EOF\n', 'latin1');
}
