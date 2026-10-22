import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { processBookingFunction } from '../services/retellBookingFunction.service.js';

/**
 * `POST /webhooks/retell/booking` — the Travel Call Agent's booking tool.
 *
 * Mounted with a RAW body parser (before the global JSON parser) so the exact
 * bytes can be signature-verified. Verification uses the Retell API key, exactly
 * like the call-lifecycle webhook.
 *
 * NOTE (must confirm before go-live): this endpoint assumes Retell signs
 * custom-function ("tool") requests with the same `x-retell-signature` scheme as
 * webhooks. If Retell does not sign tool calls, this fails closed (401) rather
 * than trusting an unauthenticated request — and the dashboard tool must instead
 * be configured with a shared secret/bearer that this handler is updated to
 * check. It never falls back to accepting unauthenticated requests.
 */
export async function retellBookingFunctionController(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const signature = req.header('x-retell-signature') ?? undefined;

  const result = await processBookingFunction({
    rawBody,
    signature,
    apiKey: env.RETELL_API_KEY,
  });

  switch (result.status) {
    case 'misconfigured':
      res.status(503).json({ error: 'booking tool verification not configured' });
      return;
    case 'unauthorized':
      res.status(401).json({ error: 'invalid signature' });
      return;
    case 'bad_request':
      res.status(400).json({ error: 'invalid request' });
      return;
    case 'unknown_call':
      // The call id is not bound to a lead we placed — refuse to act.
      res.status(403).json({ error: 'call is not associated with a known lead' });
      return;
    case 'ok':
      // The payload is what the agent/LLM receives as the tool result. It carries
      // only safe, non-PII fields (times, destination, appointment id, consultant
      // name) and never secrets, stack traces or contact details.
      res.status(200).json(result.payload);
      return;
  }
}
