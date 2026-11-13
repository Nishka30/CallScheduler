import { Router } from 'express';
import { requireCallReadAuth } from '../middleware/callReadAuth.js';
import { getLeadLifecycle } from '../controllers/leadLifecycle.controller.js';

/**
 * Authenticated lead-lifecycle read API. Requires the same bearer key as the
 * call-history API (`requireCallReadAuth`), because it exposes lead processing
 * state.
 *
 *   GET /api/leads/:leadId/lifecycle — summary + chronological lifecycle events
 */
export const leadLifecycleRouter: Router = Router();

leadLifecycleRouter.use(requireCallReadAuth);

leadLifecycleRouter.get('/:leadId/lifecycle', (req, res, next) => {
  getLeadLifecycle(req, res).catch(next);
});
