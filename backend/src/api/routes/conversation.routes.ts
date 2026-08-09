import {
  conversationIdParamSchema,
  createConversationSchema,
  listConversationsQuerySchema,
  messageIdParamSchema,
  sendMessageSchema,
  updateConversationSchema,
} from '@lumora/shared';
import { Router } from 'express';
import * as conversationController from '../controllers/conversation.controller.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { authenticate, requireVerified } from '../middleware/authenticate.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { validate } from '../middleware/validate.js';

const HOUR = 60 * 60 * 1000;

/**
 * Conversation and message routes (docs/04-data-and-api.md §2.4).
 *
 * `authenticate` then `requireVerified`, matching documents and search: a
 * conversation reads a user's own corpus, and FR-5 gates that behind
 * verification.
 */
export const conversationRouter: Router = Router();

conversationRouter.use(authenticate, requireVerified);

conversationRouter.post(
  '/',
  validate({ body: createConversationSchema }),
  asyncHandler(conversationController.create),
);

conversationRouter.get(
  '/',
  validate({ query: listConversationsQuerySchema }),
  asyncHandler(conversationController.list),
);

conversationRouter.get(
  '/:id',
  validate({ params: conversationIdParamSchema }),
  asyncHandler(conversationController.detail),
);

conversationRouter.patch(
  '/:id',
  validate({ params: conversationIdParamSchema, body: updateConversationSchema }),
  asyncHandler(conversationController.update),
);

conversationRouter.delete(
  '/:id',
  validate({ params: conversationIdParamSchema }),
  asyncHandler(conversationController.remove),
);

/**
 * 30/hour per user — the documented limit (docs §3.4, "cost control").
 *
 * Every turn is an embedding call plus a completion, which is the most
 * expensive operation in the product. Keyed by user rather than IP: an office
 * behind one NAT would otherwise share a single allowance.
 */
conversationRouter.post(
  '/:id/messages',
  rateLimit({
    name: 'chat-messages',
    limit: 30,
    windowMs: HOUR,
    keyOf: (req) => req.actor?.userId ?? null,
  }),
  validate({ params: conversationIdParamSchema, body: sendMessageSchema }),
  asyncHandler(conversationController.sendMessage),
);

/**
 * `DELETE /messages/:id` (docs §2.4) — mounted on its own router because the
 * documented path is not nested under a conversation.
 */
export const messageRouter: Router = Router();

messageRouter.use(authenticate, requireVerified);

messageRouter.delete(
  '/:id',
  validate({ params: messageIdParamSchema }),
  asyncHandler(conversationController.removeMessage),
);
