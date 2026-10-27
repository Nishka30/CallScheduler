/** How a failed Lead API request should be treated by a caller. */
export type LeadApiFailureKind =
  /** 401/403 - a configuration problem. Never retried. */
  | 'auth'
  /** 404 - the resource does not exist. Never retried. */
  | 'not_found'
  /** Other 4xx - our request is wrong. Never retried. */
  | 'client'
  /** 429 - rate limited. Retried with backoff. */
  | 'rate_limited'
  /** 5xx - upstream fault. Retried with backoff. */
  | 'server'
  /** Timeout or socket failure. Retried with backoff. */
  | 'network'
  /** The response did not match the documented contract. Never retried. */
  | 'contract';

/** Failures that may be safely retried for an idempotent GET. */
const RETRYABLE: ReadonlySet<LeadApiFailureKind> = new Set<LeadApiFailureKind>([
  'rate_limited',
  'server',
  'network',
]);

/**
 * An error from the Lead API.
 *
 * Deliberately carries no headers and no response body beyond a short,
 * sanitized message: request headers include the API key, and bodies can
 * contain lead personal data.
 */
export class LeadApiError extends Error {
  readonly kind: LeadApiFailureKind;
  readonly status?: number;
  /** Path only - never the full URL with query values. */
  readonly path: string;
  readonly retryAfterMs?: number;
  /**
   * For a `contract` failure: the Zod issue locations (`"<path>: <code>"`) that
   * failed, so the exact drifted field is observable. Paths + codes only — never
   * field VALUES, which can carry lead personal data.
   */
  readonly issues?: readonly string[];

  constructor(
    kind: LeadApiFailureKind,
    message: string,
    options: {
      status?: number;
      path: string;
      retryAfterMs?: number;
      cause?: unknown;
      issues?: readonly string[];
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LeadApiError';
    this.kind = kind;
    this.path = options.path;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.issues !== undefined) this.issues = options.issues;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  /** True when retrying can never help, so the caller should stop immediately. */
  get permanent(): boolean {
    return !this.retryable;
  }
}

/** Maps an HTTP status to how the caller should treat it. */
export function classifyStatus(status: number): LeadApiFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}
