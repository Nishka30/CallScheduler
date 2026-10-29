import { Router } from 'express';
import { healthRouter } from './health.routes.js';
import { callsRouter } from './calls.routes.js';

export const router: Router = Router();

router.use('/health', healthRouter);

// Authenticated call-history read API (source of truth for call detail/QC).
router.use('/api/calls', callsRouter);

// The Retell webhook router is mounted directly in `app.ts` (before the global
// JSON parser, because it needs the raw body for signature verification), not
// here. Future routers (Lead API sync triggers, admin endpoints) mount here;
// anything that writes or exposes lead data must be authenticated before it is
// added.
