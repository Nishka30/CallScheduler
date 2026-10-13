import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accept only a bounded, printable id from upstream; otherwise generate one. */
const SAFE_INCOMING_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Assigns a correlation id to every request and echoes it back on the
 * response, so logs, error payloads, and client reports can be tied together.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming && SAFE_INCOMING_ID.test(incoming) ? incoming : randomUUID();

  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

/**
 * `pino-http` widens `req.id` to `string | number | object`. Routes and the
 * error handler only ever want the string form we set above.
 */
export function getRequestId(req: Request): string | undefined {
  return typeof req.id === 'string' ? req.id : undefined;
}
