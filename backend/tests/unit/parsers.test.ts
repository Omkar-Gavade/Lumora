import { describe, expect, it } from 'vitest';
import { ACCEPTED_MIME_TYPES } from '@lumora/shared';
import { DocxParser } from '../../src/services/documents/parsing/docx.parser.js';
import { ParseError } from '../../src/services/documents/parsing/parser.interface.js';
import {
  findParser,
  parserFor,
  supportedMimeTypes,
} from '../../src/services/documents/parsing/parser.registry.js';
import { PdfParser } from '../../src/services/documents/parsing/pdf.parser.js';
import {
  MarkdownParser,
  TextParser,
} from '../../src/services/documents/parsing/text.parser.js';
import { buildDocx, buildNonWordZip } from '../fixtures/docx-builder.js';
import { buildCorruptPdf, buildPdf, buildTextlessPdf } from '../fixtures/pdf-builder.js';

/** Asserts a `ParseError` with a specific code, and returns it for further checks. */
async function expectParseError(work: Promise<unknown>, code: string): Promise<ParseError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ParseError);
    expect((error as ParseError).code).toBe(code);
    return error as ParseError;
  }
  throw new Error(`expected a ParseError with code ${code}, but the parse succeeded`);
}

describe('TextParser', () => {
  const parser = new TextParser();

  it('extracts and normalizes plain text', () => {
    return expect(
      parser.parse(Buffer.from('First   line.\n\n\n\nSecond paragraph.', 'utf8')),
    ).resolves.toMatchObject({ text: 'First line.\n\nSecond paragraph.' });
  });

  it('reports one page, so downstream code needs no unpaginated special case', async () => {
    const parsed = await parser.parse(Buffer.from('Body.', 'utf8'));

    expect(parsed.metadata.pageCount).toBe(1);
    expect(parsed.pages).toEqual([{ pageNumber: 1, text: 'Body.' }]);
  });

  it('strips a UTF-8 BOM instead of leaving it in the first token', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Hello.', 'utf8')]);
    expect((await parser.parse(withBom)).text).toBe('Hello.');
  });

  it('decodes UTF-16LE, which would otherwise read as interleaved NULs', async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Résumé notes.', 'utf16le'),
    ]);
    expect((await parser.parse(utf16)).text).toBe('Résumé notes.');
  });

  it('decodes UTF-16BE, which Node has no decoder for', async () => {
    const body = Buffer.from('Big endian.', 'utf16le');
    body.swap16();
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), body]);

    expect((await parser.parse(utf16be)).text).toBe('Big endian.');
  });

  it('fails with EMPTY_CONTENT rather than producing a document with no text', async () => {
    await expectParseError(parser.parse(Buffer.from('   \n\n  \t ', 'utf8')), 'EMPTY_CONTENT');
  });
});

describe('MarkdownParser', () => {
  const parser = new MarkdownParser();

  const parse = (source: string): ReturnType<MarkdownParser['parse']> =>
    parser.parse(Buffer.from(source, 'utf8'));

  it('extracts the heading tree with levels', async () => {
    const parsed = await parse('# Handbook\n\nIntro.\n\n## Retrieval\n\nHybrid search.\n');

    expect(parsed.headings.map((heading) => [heading.level, heading.text])).toEqual([
      [1, 'Handbook'],
      [2, 'Retrieval'],
    ]);
  });

  it('ignores `#` inside a fenced code block', async () => {
    // A shell comment is not a section heading, and treating it as one puts a
    // bogus entry in the section path prepended to every chunk beneath it.
    const parsed = await parse('# Real\n\n```bash\n# not a heading\nls -la\n```\n\nProse.\n');

    expect(parsed.headings.map((heading) => heading.text)).toEqual(['Real']);
  });

  it('handles tilde fences as well as backtick fences', async () => {
    const parsed = await parse('# Real\n\n~~~\n# also not a heading\n~~~\n\nProse.\n');

    expect(parsed.headings.map((heading) => heading.text)).toEqual(['Real']);
  });

  it('strips closing hashes from a closed ATX heading', async () => {
    const parsed = await parse('## Section ##\n\nBody.\n');

    expect(parsed.headings[0]?.text).toBe('Section');
  });

  it('anchors offsets in the normalized text the chunker will slice', async () => {
    const parsed = await parse('# Title\n\nBody text.\n\n## Later\n\nMore.\n');

    for (const heading of parsed.headings) {
      expect(parsed.text.slice(heading.charOffset, heading.charOffset + heading.text.length)).toBe(
        heading.text,
      );
    }
  });

  it('resolves a repeated heading to its own occurrence, not the first', async () => {
    const parsed = await parse('## Overview\n\nAlpha.\n\n## Overview\n\nBeta.\n');

    const [first, second] = parsed.headings;
    expect(first?.charOffset).toBeLessThan(second?.charOffset ?? -1);
  });

  it('uses a leading h1 as the title', async () => {
    expect((await parse('# Lumora Handbook\n\nBody.\n')).metadata.title).toBe('Lumora Handbook');
  });

  it('does not invent a title from an h2', async () => {
    expect((await parse('## Section\n\nBody.\n')).metadata.title).toBeUndefined();
  });

  it('fails with EMPTY_CONTENT on a blank file', async () => {
    await expectParseError(parse('\n\n   \n'), 'EMPTY_CONTENT');
  });
});

describe('PdfParser', () => {
  const parser = new PdfParser();

  it('extracts text from every page, in order', async () => {
    const parsed = await parser.parse(
      buildPdf({
        pages: [
          ['Chapter one opens the argument here.', 'It continues across a second line.'],
          ['Chapter two responds to the first at some length.'],
        ],
      }),
    );

    expect(parsed.metadata.pageCount).toBe(2);
    expect(parsed.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(parsed.pages[0]?.text).toContain('Chapter one opens the argument here.');
    expect(parsed.pages[1]?.text).toContain('Chapter two responds');
    expect(parsed.text.indexOf('Chapter one')).toBeLessThan(parsed.text.indexOf('Chapter two'));
  });

  it('preserves line breaks, without which de-hyphenation cannot work', async () => {
    const parsed = await parser.parse(
      buildPdf({ pages: [['First line of the page here.', 'Second line of the page here.']] }),
    );

    expect(parsed.pages[0]?.text).toContain('\n');
  });

  it('rejects a scanned PDF with NO_TEXT_LAYER and the documented message', async () => {
    // docs/00-product.md §160 specifies this wording exactly. A generic error
    // leaves the user with a failed upload and no idea that OCR is the issue.
    const error = await expectParseError(parser.parse(buildTextlessPdf(5)), 'NO_TEXT_LAYER');

    expect(error.message).toBe(
      'This PDF has no extractable text — it looks like a scanned image. OCR is not supported yet.',
    );
    expect(error.retryable).toBe(false);
  });

  it('accepts a document whose text is concentrated on a few pages', async () => {
    // A report with image-only figure pages is a good document. Only the
    // aggregate distinguishes a scan, which is why the check is not per page.
    const dense = Array.from({ length: 12 }, () => 'A dense line of prose that carries real meaning.');

    const parsed = await parser.parse(buildPdf({ pages: [dense, [], [], []] }));

    expect(parsed.metadata.pageCount).toBe(4);
  });

  it('fails with CORRUPT_FILE on damaged bytes', async () => {
    await expectParseError(parser.parse(buildCorruptPdf()), 'CORRUPT_FILE');
  });

  it('does not detach the caller’s buffer, so a retry can re-read it', async () => {
    // pdfjs takes ownership of the array it is given. Passing the original
    // would leave the caller holding an empty view on the second attempt.
    const bytes = buildPdf({
      pages: [['Retryable content, long enough to clear the scanned-document threshold.']],
    });
    const before = bytes.length;

    await parser.parse(bytes);

    expect(bytes.length).toBe(before);
    await expect(parser.parse(bytes)).resolves.toMatchObject({
      metadata: { pageCount: 1 },
    });
  });
});

describe('DocxParser', () => {
  const parser = new DocxParser();

  it('extracts text and real heading levels', async () => {
    const parsed = await parser.parse(
      buildDocx([
        { text: 'Lumora Handbook', level: 1 },
        { text: 'An introduction to the system.' },
        { text: 'Retrieval', level: 2 },
        { text: 'Hybrid search combines BM25 and vectors.' },
      ]),
    );

    expect(parsed.text).toContain('An introduction to the system.');
    expect(parsed.headings.map((heading) => [heading.level, heading.text])).toEqual([
      [1, 'Lumora Handbook'],
      [2, 'Retrieval'],
    ]);
  });

  it('anchors heading offsets in the normalized text', async () => {
    const parsed = await parser.parse(
      buildDocx([
        { text: 'Alpha', level: 1 },
        { text: 'Body one.' },
        { text: 'Beta', level: 2 },
        { text: 'Body two.' },
      ]),
    );

    for (const heading of parsed.headings) {
      expect(parsed.text.slice(heading.charOffset, heading.charOffset + heading.text.length)).toBe(
        heading.text,
      );
    }
  });

  it('keeps paragraphs separated, so the chunker has boundaries to split on', async () => {
    const parsed = await parser.parse(
      buildDocx([{ text: 'First paragraph.' }, { text: 'Second paragraph.' }]),
    );

    expect(parsed.text).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('decodes escaped entities rather than storing them literally', async () => {
    const parsed = await parser.parse(buildDocx([{ text: 'Tom & Jerry <inc> "quoted"' }]));

    expect(parsed.text).toContain('Tom & Jerry <inc> "quoted"');
  });

  it('reports one page, because DOCX pagination is computed by the renderer', async () => {
    const parsed = await parser.parse(buildDocx([{ text: 'Body.' }]));

    // Inventing page numbers would produce citations that point at nothing.
    expect(parsed.metadata.pageCount).toBe(1);
  });

  it('fails with CORRUPT_FILE on a zip that is not a Word document', async () => {
    const error = await expectParseError(parser.parse(buildNonWordZip()), 'CORRUPT_FILE');

    // Permanent: the bytes will not become a .docx on the second attempt.
    expect(error.retryable).toBe(false);
  });

  it('fails with EMPTY_CONTENT on a document with no body text', async () => {
    await expectParseError(parser.parse(buildDocx([])), 'EMPTY_CONTENT');
  });
});

describe('parser registry', () => {
  it('claims exactly the MIME types uploads accept', () => {
    // Drift between the two lists is a file that uploads successfully and then
    // sits in `queued` forever with nothing able to read it.
    expect(supportedMimeTypes()).toEqual([...ACCEPTED_MIME_TYPES].sort());
  });

  it('dispatches each accepted type to the right parser', () => {
    expect(parserFor('application/pdf').name).toBe('pdf');
    expect(
      parserFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document').name,
    ).toBe('docx');
    expect(parserFor('text/markdown').name).toBe('markdown');
    expect(parserFor('text/plain').name).toBe('text');
  });

  it('throws UNSUPPORTED_FORMAT for a type nothing claims', () => {
    expect(() => parserFor('image/png')).toThrow(ParseError);
    try {
      parserFor('image/png');
    } catch (error) {
      expect((error as ParseError).code).toBe('UNSUPPORTED_FORMAT');
      expect((error as ParseError).retryable).toBe(false);
    }
  });

  it('reports support without throwing, so the pipeline can check before downloading', () => {
    expect(findParser('text/plain')).not.toBeNull();
    expect(findParser('image/png')).toBeNull();
  });
});
