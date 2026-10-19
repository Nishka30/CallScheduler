import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { processRetellWebhook } from '../services/retellWebhook.service.js';

/**
 * `POST /webhooks/retell` — receives Retell call events.
 *
 * The route is mounted with a RAW body parser (before the global JSON parser),
 * because signature verification must run over the exact bytes Retell sent.
 *
 * A thrown error (e.g. a database failure) propagates to the central error
 * handler as a 500, so Retell retries — the merge in the repository makes a
 * retry safe. The webhook never initiates a call or writes to the CRM.
 */
export async function retellWebhookController(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const signature = req.header('x-retell-signature') ?? undefined;

  const result = await processRetellWebhook({
    rawBody,
    signature,
    apiKey: env.RETELL_API_KEY,
  });

  switch (result.status) {
    case 'misconfigured':
      // Fail closed: verification required but no secret configured.
      res.status(503).json({ error: 'webhook verification not configured' });
      return;
    case 'unauthorized':
      res.status(401).json({ error: 'invalid signature' });
      return;
    case 'bad_request':
      res.status(400).json({ error: 'invalid payload' });
      return;
    case 'ignored':
    case 'unmatched':
    case 'processed':
      // 2xx with no body, as Retell expects. Acknowledges delivery so Retell
      // does not retry; unsupported/unknown events are intentionally no-ops.
      res.status(200).end();
      return;
  }
}
