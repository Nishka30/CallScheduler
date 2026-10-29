import type { Request, Response } from 'express';
import { CallStatus } from '@prisma/client';
import {
  getCallRecordByIdOrRetellCallId,
  listCallRecords,
} from '../repositories/callRecordsRead.repository.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function serializeCall<T extends { startedAt: Date | null; endedAt: Date | null }>(record: T) {
  const durationSeconds =
    record.startedAt && record.endedAt
      ? Math.max(0, Math.round((record.endedAt.getTime() - record.startedAt.getTime()) / 1000))
      : null;
  return { ...record, durationSeconds };
}

/** GET /api/calls — paginated call metadata; transcripts are available on detail. */
export async function listCallsController(req: Request, res: Response): Promise<void> {
  const rawLimit = req.query.limit;
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
      res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
      return;
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIMIT) {
      res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
      return;
    }
  }

  const cursor = req.query.cursor;
  const leadId = req.query.leadId;
  const rawStatus = req.query.status;
  if (
    (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0)) ||
    (leadId !== undefined && (typeof leadId !== 'string' || leadId.length === 0))
  ) {
    res.status(400).json({ error: 'cursor and leadId must be non-empty strings' });
    return;
  }

  let status: CallStatus | undefined;
  if (rawStatus !== undefined) {
    if (typeof rawStatus !== 'string' || !Object.values(CallStatus).includes(rawStatus as CallStatus)) {
      res.status(400).json({ error: 'invalid call status' });
      return;
    }
    status = rawStatus as CallStatus;
  }

  const result = await listCallRecords({
    limit,
    ...(typeof cursor === 'string' ? { cursor } : {}),
    ...(typeof leadId === 'string' ? { leadId } : {}),
    ...(status ? { status } : {}),
  });

  res.status(200).json({
    data: result.records.map((record) => serializeCall(record)),
    pagination: { limit, nextCursor: result.nextCursor },
  });
}

/** GET /api/calls/:id — full persisted call record, including transcript and analysis. */
export async function getCallByIdController(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  if (!id || id.trim().length === 0) {
    res.status(400).json({ error: 'call id is required' });
    return;
  }

  const record = await getCallRecordByIdOrRetellCallId(id);
  if (!record) {
    res.status(404).json({ error: 'call record not found' });
    return;
  }

  res.status(200).json({ data: serializeCall(record) });
}
