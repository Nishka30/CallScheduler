import type { Request, Response } from 'express';
import { z } from 'zod';
import { CallOutcome, CallStatus } from '@prisma/client';
import {
  getCallRecordDetail,
  listCallRecords,
  type CallListFilter,
} from '../repositories/callRecord.repository.js';

/**
 * Read-only call-history API (authenticated upstream by `requireCallReadAuth`).
 *
 * The list endpoint returns summary rows only (no transcript/analysis). The detail
 * endpoint returns the full persisted record. `call_records` stores no phone
 * numbers, so no contact PII is exposed; transcripts are only on the detail route,
 * which is why the whole router is authenticated.
 */

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
  leadId: z.string().min(1).optional(),
  status: z.nativeEnum(CallStatus).optional(),
  outcome: z.nativeEnum(CallOutcome).optional(),
  since: z.coerce.date().optional(),
});

export async function listCalls(req: Request, res: Response): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid query parameters' });
    return;
  }
  const { limit, cursor, ...rest } = parsed.data;
  const filter: CallListFilter = {
    ...(rest.leadId === undefined ? {} : { leadId: rest.leadId }),
    ...(rest.status === undefined ? {} : { status: rest.status }),
    ...(rest.outcome === undefined ? {} : { outcome: rest.outcome }),
    ...(rest.since === undefined ? {} : { since: rest.since }),
  };

  const page = await listCallRecords(filter, {
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });
  res.status(200).json({ items: page.items, nextCursor: page.nextCursor });
}

export async function getCall(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (typeof id !== 'string' || id.length === 0) {
    res.status(400).json({ error: 'missing id' });
    return;
  }
  const record = await getCallRecordDetail(id);
  if (!record) {
    res.status(404).json({ error: 'call not found' });
    return;
  }
  res.status(200).json(record);
}
