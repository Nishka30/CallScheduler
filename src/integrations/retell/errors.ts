/** How a failed Retell request should be treated by a caller. */
export type RetellFailureKind =
  /** Calling is disabled by the master switch. No request was made. */
  | 'disabled'
  /** Config (key / number / agent id) missing or malformed. No request was made. */
  | 'config'
  /** The destination number was not valid E.164. No request was made. */
  | 'invalid_destination'
  /** 401/403 - a credential problem. */
  | 'auth'
  /** Other 4xx - our request is wrong. */
  | 'client'
  /** 429 - rate limited. */
  | 'rate_limited'
  /** 5xx - upstream fault. */
  | 'server'
  /** Timeout or socket failure AFTER the request may have been sent. Uncertain. */
  | 'network'
  /** The response did not match the documented contract (e.g. no call_id). */
  | 'contract';

/**
 * An error from the Retell integration.
 *
 * Carries no headers and no response body beyond a short, sanitized message:
 * request headers include the bearer key, and bodies can echo the destination
 * number (lead PII).
 *
 * `uncertain` is the safety-critical flag. Unlike a read API, creating a call
 * is NOT idempotent: a timeout or dropped socket after the request left the
 * process may mean the call WAS placed. Such a failure is marked `uncertain` so
 * the caller never treats it as "definitely not called" and never auto-redials
 * - it must be reconciled (future webhook / manual check), exactly as
 * `requeueForRetry()` already refuses to requeue a CALLING lead.
 */
export class RetellApiError extends Error {
  readonly kind: RetellFailureKind;
  readonly status?: number;
  readonly path: string;

  constructor(
    kind: RetellFailureKind,
    message: string,
    options: { status?: number; path: string; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RetellApiError';
    this.kind = kind;
    this.path = options.path;
    if (options.status !== undefined) this.status = options.status;
  }

  /**
   * True when the request may have reached Retell and placed a call despite the
   * error. The caller must NOT assume "not called" or auto-retry these.
   */
  get uncertain(): boolean {
    // A 5xx or a network failure can both land after the call was accepted.
    return this.kind === 'network' || this.kind === 'server';
  }

  /** True when no external request was made at all (pure pre-flight refusal). */
  get preflight(): boolean {
    return (
      this.kind === 'disabled' || this.kind === 'config' || this.kind === 'invalid_destination'
    );
  }
}

/** Maps an HTTP status to how the caller should treat it. */
export function classifyStatus(status: number): RetellFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}

/** Safe, structured, PII-free fields describing a `RetellApiError` for logs. */
export interface SafeRetellErrorInfo {
  kind: RetellFailureKind;
  status?: number;
  /** The create-call path is a constant with no PII; logged as-is. */
  path: string;
  /** The call MAY have been placed; never treat as "not called" / never redial. */
  uncertain: boolean;
  /** No external request was made (pure pre-flight refusal). */
  preflight: boolean;
}

/**
 * Reduces a `RetellApiError` to safe log fields: kind, status, path, and the
 * two safety flags. Never includes the bearer key or the destination number.
 */
export function describeRetellError(error: RetellApiError): SafeRetellErrorInfo {
  return {
    kind: error.kind,
    ...(error.status === undefined ? {} : { status: error.status }),
    path: error.path,
    uncertain: error.uncertain,
    preflight: error.preflight,
  };
}
