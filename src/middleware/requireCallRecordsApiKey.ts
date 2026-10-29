import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

/**
 * Protects the call-record API because responses contain transcripts and other
 * customer data. Configure a dedicated, high-entropy CALL_RECORDS_API_KEY.
 */
export function requireCallRecordsApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = env.CALL_RECORDS_API_KEY;
  if (!expected) {
    res.status(503).json({ error: 'call records API is not configured' });
    return;
  }

  const supplied = req.header('x-call-records-api-key');
  if (!supplied) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  const valid =
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer);

  if (!valid) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
}
