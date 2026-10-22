import { Router, raw } from 'express';
import { retellWebhookController } from '../controllers/retellWebhook.controller.js';
import { retellBookingFunctionController } from '../controllers/retellBookingFunction.controller.js';

/** Raw-body limit for webhook payloads (call objects with analysis fit easily). */
const WEBHOOK_BODY_LIMIT = '150kb';

/**
 * Retell webhook router.
 *
 * Uses a RAW body parser (not the global JSON parser) so signature verification
 * can run over the exact bytes Retell sent — re-serialised JSON would not
 * verify. This router is therefore mounted in `app.ts` BEFORE `express.json()`.
 *
 * `type: () => true` captures the body as a Buffer regardless of the
 * Content-Type header, so a signature can always be checked.
 */
export const retellWebhookRouter: Router = Router();

retellWebhookRouter.post(
  '/',
  raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
  (req, res, next) => {
    retellWebhookController(req, res).catch(next);
  },
);

/**
 * `POST /webhooks/retell/booking` — the agent's booking tool (custom function).
 *
 * Also raw-body (own signature verification), and isolated from the
 * call-lifecycle webhook above: a tool request is a different payload shape and
 * is dispatched by function name, never confused with a `call_ended` event.
 */
retellWebhookRouter.post(
  '/booking',
  raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
  (req, res, next) => {
    retellBookingFunctionController(req, res).catch(next);
  },
);
