import multer, { MulterError } from 'multer';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD } from '@lumora/shared';
import { PayloadTooLargeError, ValidationError } from '../../domain/errors/index.js';
import type { AppError } from '../../domain/errors/index.js';

/**
 * Multipart handling for document uploads (docs/03-backend.md §3).
 *
 * **Memory storage, with the cap applied before buffering.** Multer enforces
 * `fileSize` as bytes arrive and aborts the stream the moment it is exceeded,
 * so a 5 GB upload costs 25 MB of memory and a closed socket rather than
 * filling a disk. Disk storage would mean writing an unvalidated file to the
 * filesystem before anything has decided it is acceptable — and then having to
 * clean it up on every rejection path.
 *
 * The buffer goes to the `StorageProvider` only after magic-byte validation
 * has passed, which is why nothing here touches storage.
 */
const multipart = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES_PER_UPLOAD,
    // A multipart body is a sequence of parts, and nothing stops a client
    // sending a hundred thousand tiny fields. Bounded so parsing cannot be
    // turned into the denial of service the file limits already prevent.
    fields: 10,
    parts: MAX_FILES_PER_UPLOAD + 10,
  },
});

/**
 * Translates multer's errors into the application's hierarchy.
 *
 * Without this a `LIMIT_FILE_SIZE` reaches the terminal handler as an
 * unrecognized throw and answers 500 — telling the user we broke when they
 * sent a file that was simply too big, and inviting a client to retry the same
 * oversized payload forever.
 */
export function uploadFiles(field: string): RequestHandler {
  const handler = multipart.array(field, MAX_FILES_PER_UPLOAD);

  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, (error: unknown) => {
      if (!error) {
        next();
        return;
      }

      if (error instanceof MulterError) {
        next(toAppError(error));
        return;
      }

      next(error);
    });
  };
}

function toAppError(error: MulterError): AppError {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return new PayloadTooLargeError(
        `Files must be under ${String(Math.floor(MAX_FILE_BYTES / (1024 * 1024)))} MB.`,
      );

    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_PART_COUNT':
      return new ValidationError(`Upload at most ${String(MAX_FILES_PER_UPLOAD)} files at a time.`);

    case 'LIMIT_UNEXPECTED_FILE':
      // The client attached files under a field the route does not read —
      // reported as a validation failure so it names the expected field
      // rather than looking like a server fault.
      return new ValidationError('Unexpected file field.', [
        { path: error.field ?? 'file', message: 'Attach files as "files".' },
      ]);

    default:
      return new ValidationError('That upload could not be read.');
  }
}
