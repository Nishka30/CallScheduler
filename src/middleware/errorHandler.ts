import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, ErrorCode, type ErrorResponseBody } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getRequestId } from './requestId.js';

interface BodyParserError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    error instanceof Error &&
    typeof (error as BodyParserError).type === 'string' &&
    (error as BodyParserError).type!.startsWith('entity.')
  );
}

/**
 * Central error handler: the single place that turns anything thrown in the
 * app into a consistent JSON response.
 *
 * Unknown errors are reported as a generic 500 - messages and stack traces from
 * unexpected failures are logged, never returned.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const requestId = getRequestId(req);
  let statusCode = 500;
  let body: ErrorResponseBody;

  if (error instanceof AppError) {
    statusCode = error.statusCode;
    body = {
      error: {
        code: error.code,
        message: error.message,
        ...(requestId ? { requestId } : {}),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  } else if (error instanceof ZodError) {
    statusCode = 400;
    body = {
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Request validation failed',
        ...(requestId ? { requestId } : {}),
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  } else if (isBodyParserError(error)) {
    const parserStatus = error.status ?? error.statusCode ?? 400;
    statusCode = parserStatus;
    body = {
      error: {
        code: parserStatus === 413 ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.BAD_REQUEST,
        message: parserStatus === 413 ? 'Request payload too large' : 'Malformed request body',
        ...(requestId ? { requestId } : {}),
      },
    };
  } else {
    body = {
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Internal server error',
        ...(requestId ? { requestId } : {}),
      },
    };
  }

  const logPayload = {
    requestId,
    method: req.method,
    path: req.path,
    statusCode,
    err: error instanceof Error ? { name: error.name, message: error.message } : undefined,
  };

  if (statusCode >= 500) {
    logger.error(
      { ...logPayload, stack: error instanceof Error ? error.stack : undefined },
      'unhandled request error',
    );
  } else {
    logger.warn(logPayload, 'request failed');
  }

  res.status(statusCode).json(body);
}
