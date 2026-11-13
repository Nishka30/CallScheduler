import { Router } from 'express';
import { healthRouter } from './health.routes.js';
import { callsRouter } from './calls.routes.js';
import { leadLifecycleRouter } from './leadLifecycle.routes.js';
import { leadTraceRouter } from './leadTrace.routes.js';

export const router: Router = Router();

router.use('/health', healthRouter);

// Authenticated call-history read API (source of truth for call detail/QC).
router.use('/api/calls', callsRouter);

// Authenticated lead-lifecycle read API (source of truth for the Lead Trace UI).
router.use('/api/leads', leadLifecycleRouter);

// Self-contained Lead Trace page (vanilla HTML/JS). Served unauthenticated; the
// page calls the authenticated lifecycle API with an operator-supplied key.
router.use('/lead-trace', leadTraceRouter);

// The Retell webhook router is mounted directly in `app.ts` (before the global
// JSON parser, because it needs the raw body for signature verification), not
// here. Future routers (Lead API sync triggers, admin endpoints) mount here;
// anything that writes or exposes lead data must be authenticated before it is
// added.
