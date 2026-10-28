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

/**
 * Rewrites a Lead API path to a safe template for logging. Identifier segments
 * are replaced with placeholders because a person key can be `email:<address>`
 * (PII) and a lead id is a raw identifier. The endpoint SHAPE — the useful
 * diagnostic — is kept; the values are not.
 */
export function sanitizeLeadApiPath(path: string): string {
  return path
    .replace(/\/persons\/[^/?#]+/i, '/persons/:personKey')
    .replace(/\/leads\/[^/?#]+/i, '/leads/:leadId')
    .replace(/\/appointments\/[^/?#]+/i, '/appointments/:id');
}

/** Safe, structured, PII-free fields describing a `LeadApiError` for logs. */
export interface SafeLeadApiErrorInfo {
  kind: LeadApiFailureKind;
  status?: number;
  /** Endpoint template, never a raw id/email — see `sanitizeLeadApiPath`. */
  path: string;
  /** Whether retrying can ever help (false ⇒ transient). */
  permanent: boolean;
  /** For a network failure: whether it was a timeout vs another socket error. */
  timedOut?: boolean;
  /** For a contract failure: the Zod issue locations (paths + codes only). */
  issues?: readonly string[];
}

/**
 * Reduces a `LeadApiError` to safe, structured log fields. Never includes the
 * API key, a raw path/id/email, or an upstream response body — only the kind,
 * status, templated endpoint, retryability, a timeout flag, and (for contract
 * errors) the sanitized issue list already carried on the error.
 */
export function describeLeadApiError(error: LeadApiError): SafeLeadApiErrorInfo {
  return {
    kind: error.kind,
    ...(error.status === undefined ? {} : { status: error.status }),
    path: sanitizeLeadApiPath(error.path),
    permanent: error.permanent,
    ...(error.kind === 'network' ? { timedOut: /timed out/i.test(error.message) } : {}),
    ...(error.issues === undefined ? {} : { issues: error.issues }),
  };
}
