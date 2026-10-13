import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';

/** Converts unmatched routes into the standard 404 error response. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Route ${req.method} ${req.path} not found`));
}
