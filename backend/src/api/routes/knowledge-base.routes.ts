import {
  addKnowledgeBaseDocumentsSchema,
  createKnowledgeBaseSchema,
  knowledgeBaseDocumentParamSchema,
  knowledgeBaseIdParamSchema,
  updateKnowledgeBaseSchema,
} from '@lumora/shared';
import { Router } from 'express';
import * as knowledgeBaseController from '../controllers/knowledge-base.controller.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';

/**
 * Knowledge Base routes (docs/07-knowledge-base.md §7).
 *
 * `authenticate` on the whole router, matching documents and conversations.
 * Ownership is enforced where it belongs — in repository queries scoped by
 * `user_id` — so no route here performs its own authorization check, and none
 * can forget to.
 *
 * Conversation association is deliberately **not** a route in this file. It
 * lives on `POST /conversations` and `PATCH /conversations/:id`, because the
 * thing being changed is a property of a conversation; a second endpoint for
 * it would be a second way to write the same column.
 */
export const knowledgeBaseRouter: Router = Router();

knowledgeBaseRouter.use(authenticate);

knowledgeBaseRouter.post(
  '/',
  validate({ body: createKnowledgeBaseSchema }),
  asyncHandler(knowledgeBaseController.create),
);

knowledgeBaseRouter.get('/', asyncHandler(knowledgeBaseController.list));

knowledgeBaseRouter.get(
  '/:id',
  validate({ params: knowledgeBaseIdParamSchema }),
  asyncHandler(knowledgeBaseController.detail),
);

knowledgeBaseRouter.patch(
  '/:id',
  validate({ params: knowledgeBaseIdParamSchema, body: updateKnowledgeBaseSchema }),
  asyncHandler(knowledgeBaseController.update),
);

knowledgeBaseRouter.delete(
  '/:id',
  validate({ params: knowledgeBaseIdParamSchema }),
  asyncHandler(knowledgeBaseController.remove),
);

/*
  What a delete would cost, asked before confirming it.

  A separate read rather than a field on the base itself: the count is only
  wanted at the moment of deletion, and putting it on every list response would
  add a correlated subquery to the hottest query this feature has.
*/
knowledgeBaseRouter.get(
  '/:id/impact',
  validate({ params: knowledgeBaseIdParamSchema }),
  asyncHandler(knowledgeBaseController.impact),
);

knowledgeBaseRouter.get(
  '/:id/documents',
  validate({ params: knowledgeBaseIdParamSchema }),
  asyncHandler(knowledgeBaseController.listDocuments),
);

knowledgeBaseRouter.post(
  '/:id/documents',
  validate({ params: knowledgeBaseIdParamSchema, body: addKnowledgeBaseDocumentsSchema }),
  asyncHandler(knowledgeBaseController.addDocuments),
);

knowledgeBaseRouter.delete(
  '/:id/documents/:documentId',
  validate({ params: knowledgeBaseDocumentParamSchema }),
  asyncHandler(knowledgeBaseController.removeDocument),
);
