import { Router } from 'express';
import { requireCallReadAuth } from '../middleware/callReadAuth.js';
import { getCall, listCalls } from '../controllers/calls.controller.js';

/**
 * Authenticated call-history read API. Every route requires a valid bearer key
 * (`requireCallReadAuth`), because the detail route returns transcripts.
 *
 *   GET /api/calls       — paginated summary list (filters: leadId, status, outcome, since)
 *   GET /api/calls/:id    — full detail by internal id (UUID) or Retell call id
 */
export const callsRouter: Router = Router();

callsRouter.use(requireCallReadAuth);

callsRouter.get('/', (req, res, next) => {
  listCalls(req, res).catch(next);
});

callsRouter.get('/:id', (req, res, next) => {
  getCall(req, res).catch(next);
});
