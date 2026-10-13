import { Router } from 'express';
import { healthRouter } from './health.routes.js';

export const router: Router = Router();

router.use('/health', healthRouter);

// Future routers (Lead API sync triggers, Retell webhooks, admin endpoints)
// mount here. Anything that writes or exposes lead data must be authenticated
// before it is added.
