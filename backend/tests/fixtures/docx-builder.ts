import { deflateRawSync } from 'node:zlib';

/**
 * Builds real .docx files in memory.
 *
 * A DOCX is a zip of XML parts, and Node ships `zlib` but no archive writer —
 * so the archive is written here. That is a hundred lines to avoid a
 * dependency, which would be a poor trade if the payoff were only convenience.
 * It is not: the fixtures a parser test needs are a document with a specific
 * heading tree, a document with an empty body, and a file that is a zip but not
 * a Word document, and none of those is something you can obtain by saving a
 * file in Word and committing it.
 *
 * The result is a genuine archive that mammoth opens with no special handling.
 */

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * CRC-32, which the zip format requires per entry.
 *
 * Table-driven and computed once. A wrong checksum is not ignored — the reader
 * rejects the archive — so this cannot be stubbed out.
 */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Writes a zip archive with deflated entries.
 *
 * Deflate rather than stored, because that is what every real .docx uses and
 * the point of the fixture is to be indistinguishable from one. `deflateRaw`
 * is the exact codec the format specifies — method 8 is a bare deflate stream
 * with no zlib wrapper, and using `deflateSync` here produces an archive that
 * fails to inflate.
 */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // mod time — fixed, so builds are byte-identical
    local.writeUInt16LE(0x0021, 12); // mod date (1980-01-01)
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    // Where this entry's local header starts — the reader seeks here, so it
    // must be the running total of everything written before it.
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, directory, end]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One block: a heading at `level`, or a body paragraph when level is absent.
 *
 * `Heading1`–`Heading6` are Word's built-in style ids, and mapping them to
 * `<h1>`–`<h6>` is behaviour mammoth provides out of the box. Using the real
 * ids is what makes this fixture exercise the same path a Word-authored file
 * does, rather than a shape invented to satisfy the parser.
 */
export interface DocxBlock {
  text: string;
  level?: number;
}

function paragraph(block: DocxBlock): string {
  const style =
    block.level === undefined
      ? ''
      : `<w:pPr><w:pStyle w:val="Heading${String(block.level)}"/></w:pPr>`;

  return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(block.text)}</w:t></w:r></w:p>`;
}

export function buildDocx(blocks: DocxBlock[]): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${blocks.map(paragraph).join('')}</w:body>
</w:document>`;

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

/**
 * A well-formed zip that is not a Word document.
 *
 * The realistic version of "corrupt": a renamed .xlsx or an OpenDocument file
 * opens as an archive and then has no `word/document.xml`. Bytes that are not
 * a zip at all fail earlier and less interestingly.
 */
export function buildNonWordZip(): Buffer {
  return buildZip([{ name: 'readme.txt', data: Buffer.from('not a word document', 'utf8') }]);
}
