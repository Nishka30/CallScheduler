import { Router } from 'express';
import { healthCheck, readinessCheck, workerStatus } from '../controllers/health.controller.js';

export const healthRouter: Router = Router();

// Liveness and readiness are intentionally separate: an orchestrator should
// restart on liveness failure but only stop routing traffic on readiness
// failure. Both are unauthenticated - they expose no data and probes usually
// cannot present credentials.
healthRouter.get('/', healthCheck);
healthRouter.get('/ready', readinessCheck);
// Background worker status (enabled/running, last poll, safe tallies). No PII.
healthRouter.get('/worker', workerStatus);
