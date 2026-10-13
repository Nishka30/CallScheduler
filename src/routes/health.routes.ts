import { Router } from 'express';
import { healthCheck, readinessCheck } from '../controllers/health.controller.js';

export const healthRouter: Router = Router();

// Liveness and readiness are intentionally separate: an orchestrator should
// restart on liveness failure but only stop routing traffic on readiness
// failure. Both are unauthenticated - they expose no data and probes usually
// cannot present credentials.
healthRouter.get('/', healthCheck);
healthRouter.get('/ready', readinessCheck);
