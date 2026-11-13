import type { Request, Response } from 'express';
import { z } from 'zod';
import { getLeadLifecycleTrace } from '../services/leadLifecycle.service.js';

/**
 * Read-only lead-lifecycle API (authenticated upstream by `requireCallReadAuth`).
 *
 * `GET /api/leads/:leadId/lifecycle` returns a non-PII processing/call summary
 * plus the chronological lifecycle events persisted in `lead_lifecycle_events`.
 * The id is the external Lead API lead id; there is no email/phone lookup here
 * because this service deliberately stores no contact details.
 */

const leadIdSchema = z.string().trim().min(1).max(128);

export async function getLeadLifecycle(req: Request, res: Response): Promise<void> {
  const parsed = leadIdSchema.safeParse(req.params['leadId']);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid lead id' });
    return;
  }

  const trace = await getLeadLifecycleTrace(parsed.data);
  if (!trace.lead && trace.events.length === 0) {
    res.status(404).json({ error: 'lead not found' });
    return;
  }

  res.status(200).json(trace);
}
