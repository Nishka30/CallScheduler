import { Router } from 'express';
import { requireCallReadAuth } from '../middleware/callReadAuth.js';
import { getLeadLifecycle, getLeadLifecycleList } from '../controllers/leadLifecycle.controller.js';

/**
 * Authenticated lead-lifecycle read API. Requires the same bearer key as the
 * call-history API (`requireCallReadAuth`), because it exposes lead processing
 * state.
 *
 *   GET /api/leads/lifecycles        — lead-list summary (deterministic state)
 *   GET /api/leads/:leadId/lifecycle — summary + chronological lifecycle events
 */
export const leadLifecycleRouter: Router = Router();

leadLifecycleRouter.use(requireCallReadAuth);

// Fixed path first so it is never captured by the `:leadId` param route.
leadLifecycleRouter.get('/lifecycles', (req, res, next) => {
  getLeadLifecycleList(req, res).catch(next);
});

leadLifecycleRouter.get('/:leadId/lifecycle', (req, res, next) => {
  getLeadLifecycle(req, res).catch(next);
});
