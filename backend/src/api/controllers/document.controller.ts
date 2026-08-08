import type { ListDocumentsQuery, documentIdParamSchema } from '@lumora/shared';
import type { z } from 'zod';
import type { Request, Response } from 'express';
import type { Actor } from '../../domain/entities/user.js';

type DocumentIdParam = z.infer<typeof documentIdParamSchema>;
import { UnauthorizedError, ValidationError } from '../../domain/errors/index.js';
import { documentService, type IncomingFile } from '../../services/documents/document.service.js';

/**
 * Controllers read validated input, call one service, and map the result to an
 * HTTP response — no business rules, no SQL (docs/03-backend.md §1).
 *
 * Standalone functions rather than object methods, matching the other
 * controllers: route files pass these by reference, and a detached method
 * carries a `this` bound to nothing.
 */

function requireActor(req: Request): Actor {
  if (!req.actor) throw new UnauthorizedError();
  return req.actor;
}

/**
 * `req.files` is typed by multer as a union covering both its array and
 * fields modes. The route uses `.array()`, so narrowing here keeps the cast
 * in one place instead of at every read.
 */
/**
 * The validated `:id`.
 *
 * Express 5 types every param as `string | string[]` because a route *can*
 * declare a repeated segment. `validate({ params: documentIdParamSchema })`
 * has already replaced `req.params` with the parsed object by the time a
 * handler runs, so the narrowing here is reading what validation produced —
 * not asserting a shape nothing checked.
 */
function documentIdFrom(req: Request): string {
  const { id } = req.params as unknown as DocumentIdParam;
  return id;
}

function filesFrom(req: Request): IncomingFile[] {
  const files = req.files;
  if (!Array.isArray(files)) return [];
  return files.map((file) => ({ originalname: file.originalname, buffer: file.buffer }));
}

/**
 * **202, not 201** (docs/04-data-and-api.md §2.3).
 *
 * The rows exist and the bytes are stored, but the work has not happened — the
 * documents are `queued` and ingestion is a job. A 201 would claim the
 * resource is complete, and the client would stop polling for a status that is
 * still going to change.
 */
export async function upload(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const files = filesFrom(req);

  if (files.length === 0) {
    throw new ValidationError('Attach at least one file.', [
      { path: 'files', message: 'No file was received.' },
    ]);
  }

  const result = await documentService.upload(actor.userId, files);
  res.status(202).json(result);
}

export async function list(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const query = req.query as unknown as ListDocumentsQuery;

  res.status(200).json(
    await documentService.list(actor.userId, {
      limit: query.limit,
      cursor: query.cursor,
      status: query.status,
    }),
  );
}

export async function getById(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  res.status(200).json(await documentService.getById(actor.userId, documentIdFrom(req)));
}

/** 204: the row, and the bytes, are gone (FR-15). */
export async function remove(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  await documentService.delete(actor.userId, documentIdFrom(req));
  res.status(204).end();
}

/** FR-16 — the numbers behind the sidebar meter. */
export async function usage(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  res.status(200).json(await documentService.usageFor(actor.userId));
}
