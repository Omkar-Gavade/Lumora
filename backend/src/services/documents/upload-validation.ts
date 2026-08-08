import { extname } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_FILENAME_LENGTH,
  type AcceptedMimeType,
} from '@lumora/shared';

/**
 * What a file turned out to be, or why it was rejected.
 *
 * A discriminated union rather than throwing, because one bad file in a batch
 * of five must not fail the other four (docs/04-data-and-api.md §2.3 allows up
 * to five per request). The caller collects rejections and still accepts the
 * rest.
 */
export type ValidationResult =
  | { ok: true; mimeType: AcceptedMimeType; filename: string }
  | { ok: false; code: ValidationFailureCode; message: string };

export type ValidationFailureCode =
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TYPE_MISMATCH';

/**
 * Formats with no magic signature.
 *
 * PDF and DOCX have unambiguous headers (`%PDF`, and a ZIP header plus an
 * OOXML content type). Plain text and Markdown have none — they are "whatever
 * decodes as text" — so they are verified by content inspection below rather
 * than by a signature that does not exist.
 */
const TEXT_LIKE: AcceptedMimeType[] = ['text/plain', 'text/markdown'];

/**
 * Strips everything that makes a filename dangerous, keeping it recognisable.
 *
 * This name is **display only** — the storage key is a server-generated UUID,
 * so nothing here is load-bearing for path traversal. It matters because the
 * name is rendered in a browser, echoed in errors, and will one day appear in
 * a `Content-Disposition` header, and each of those is a different injection
 * surface.
 *
 * Directory separators and `..` go first: a browser will happily send
 * `../../etc/passwd` as a field name, and while it cannot reach the
 * filesystem here, storing it means the UI renders a path that looks like an
 * attack succeeded.
 */
export function sanitizeFilename(name: string): string {
  const base = name
    // Take the last segment, whichever separator was used.
    .split(/[/\\]/)
    .pop()
    ?.trim();

  if (!base) return 'untitled';

  const cleaned = base
    // Control characters would break a header and can hide text in a UI.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Reserved on Windows, and `"` closes a Content-Disposition value early.
    .replace(/["*:<>?|]/g, '')
    .replace(/^\.+/, '')
    .trim();

  if (cleaned.length === 0) return 'untitled';

  // Truncate from the front, keeping the extension: a name cut mid-extension
  // reads as corrupt, and the extension is the part a user scans for.
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;

  const extension = extname(cleaned).slice(0, 16);
  return cleaned.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
}

/**
 * Decides what a file actually is.
 *
 * docs/03-backend.md §3: "sniffs magic bytes (`file-type`) and rejects any
 * mismatch with the declared extension. Extension and client `Content-Type`
 * are both attacker-controlled and are never trusted."
 *
 * The order matters. Size and emptiness are checked first because they are
 * free; sniffing allocates and decodes. The declared extension is used only to
 * *cross-check* the sniffed result — never to decide the type — so a `.pdf`
 * containing a ZIP is rejected rather than stored as a PDF.
 */
export async function validateUpload(
  declaredName: string,
  bytes: Buffer,
): Promise<ValidationResult> {
  if (bytes.length === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: 'The file is empty.' };
  }

  if (bytes.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      message: `Files must be under ${String(Math.floor(MAX_FILE_BYTES / (1024 * 1024)))} MB.`,
    };
  }

  const filename = sanitizeFilename(declaredName);
  const extension = extname(filename).toLowerCase();
  const expected = ACCEPTED_EXTENSIONS[extension];

  if (!expected) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FILE_TYPE',
      message: 'Lumora reads PDF, DOCX, TXT, and Markdown files.',
    };
  }

  const sniffed = await fileTypeFromBuffer(bytes);

  if (TEXT_LIKE.includes(expected)) {
    /*
      Text has no signature, so `file-type` returns undefined for it — and
      returning undefined is exactly what a genuine .txt should do. A *defined*
      result here means the bytes are some binary format wearing a .txt
      extension, which is the mismatch worth rejecting.
    */
    if (sniffed) {
      return {
        ok: false,
        code: 'FILE_TYPE_MISMATCH',
        message: `That file is named ${extension} but contains ${sniffed.ext} data.`,
      };
    }

    if (!looksLikeText(bytes)) {
      return {
        ok: false,
        code: 'FILE_TYPE_MISMATCH',
        message: 'That file does not contain readable text.',
      };
    }

    return { ok: true, mimeType: expected, filename };
  }

  if (!sniffed) {
    return {
      ok: false,
      code: 'FILE_TYPE_MISMATCH',
      message: `That file is named ${extension} but its contents are not a valid ${extension.slice(1).toUpperCase()}.`,
    };
  }

  /*
    DOCX is a ZIP, and `file-type` reports the OOXML type when it can read the
    archive's content types — but reports a bare `zip` for some producers.
    Accepting either would let any ZIP through as a DOCX; accepting neither
    would reject valid files from real word processors. The archive is checked
    for the OOXML marker instead.
  */
  if (expected.includes('wordprocessingml')) {
    const isDocx = sniffed.mime === expected || (sniffed.mime === 'application/zip' && isOoxmlDocument(bytes));
    return isDocx
      ? { ok: true, mimeType: expected, filename }
      : {
          ok: false,
          code: 'FILE_TYPE_MISMATCH',
          message: 'That file is named .docx but is not a Word document.',
        };
  }

  if (sniffed.mime !== expected) {
    return {
      ok: false,
      code: 'FILE_TYPE_MISMATCH',
      message: `That file is named ${extension} but contains ${sniffed.ext} data.`,
    };
  }

  return { ok: true, mimeType: expected, filename };
}

/**
 * Heuristic for "is this text a human wrote".
 *
 * A NUL byte is the giveaway — no text encoding this product accepts produces
 * one, and every binary format does. A high proportion of other control
 * characters is the secondary signal. Only the first few KB are examined:
 * enough to be confident, bounded so a 25 MB file is not scanned twice.
 */
function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8192);
  let suspicious = 0;

  for (const byte of sample) {
    if (byte === 0) return false;
    // Everything below 0x20 except tab, newline, carriage return.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) suspicious += 1;
  }

  return suspicious / sample.length < 0.05;
}

/**
 * Looks for the OOXML document marker inside the archive.
 *
 * A real .docx always contains `word/document.xml`. Reading the central
 * directory properly would mean unzipping; scanning the buffer for the entry
 * name is enough to tell a Word file from an arbitrary ZIP, and it cannot be
 * fooled into executing anything because nothing is extracted.
 */
function isOoxmlDocument(bytes: Buffer): boolean {
  return bytes.includes(Buffer.from('word/document.xml'));
}
