/** Stable, client-facing error codes. */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * An error whose message is safe to return to the caller.
 *
 * Anything that is NOT an AppError is treated as unexpected and reported as a
 * generic 500, so internal details never leak.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, ErrorCode.BAD_REQUEST, message, { details });
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError(404, ErrorCode.NOT_FOUND, message);
  }

  static conflict(message: string): AppError {
    return new AppError(409, ErrorCode.CONFLICT, message);
  }

  static serviceUnavailable(message = 'Service temporarily unavailable'): AppError {
    return new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, message);
  }
}

/** Shape of every error response the API returns. */
export interface ErrorResponseBody {
  error: {
    code: ErrorCodeValue;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}
