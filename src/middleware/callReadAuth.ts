import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

/**
 * Authenticates the call-history read API with a bearer key.
 *
 * Fails CLOSED: if `CALL_READ_API_KEY` is not configured, the endpoints return
 * 503 rather than exposing call transcripts / detail unauthenticated. A missing or
 * wrong key is 401. The comparison is constant-time. The key is never logged.
 */
export function requireCallReadAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = env.CALL_READ_API_KEY;
  if (!configured) {
    res.status(503).json({ error: 'call read API is not configured' });
    return;
  }

  const header = req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (presented.length === 0 || !constantTimeEqual(presented, configured)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
