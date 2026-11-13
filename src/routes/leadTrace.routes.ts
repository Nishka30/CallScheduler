import { Router } from 'express';
import { LEAD_TRACE_HTML } from '../controllers/leadTrace.page.js';

/**
 * Serves the self-contained Lead Trace page at `GET /lead-trace`.
 *
 * The page carries no lead data (it fetches the authenticated lifecycle API with
 * a bearer key the operator supplies), so the HTML itself is served without auth.
 * A route-scoped Content-Security-Policy relaxes the global helmet default just
 * enough to allow this one page's inline <style>/<script>, while keeping network
 * access limited to same-origin (`connect-src 'self'`).
 */
export const leadTraceRouter: Router = Router();

leadTraceRouter.get('/', (_req, res) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
  );
  res.type('html').status(200).send(LEAD_TRACE_HTML);
});
