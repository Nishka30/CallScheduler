import { env, requireLeadApiKey, type Env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { classifyStatus, LeadApiError } from '../leadApi/errors.js';
import {
  finalStatusRequestSchema,
  finalStatusResponseSchema,
  callInProgressResponseSchema,
  type FinalStatusRequest,
} from './callerStatus.schemas.js';

/**
 * Client for the Guided Boost caller FINAL-STATUS report
 * (`POST /api/caller/leads/<lead_id>/status`).
 *
 * Auth (David's confirmed contract): the existing caller key `LEAD_API_KEY_CALLER`
 * as `X-Lead-API-Key`, plus the caller write identity `CRM_AGENT_EMAIL` as
 * `X-Agent-Email` — the SAME identity the CRM notes already use. No new credential.
 * Base URL is `CALLER_QUEUE_BASE_URL` (the caller endpoints share a host).
 *
 * Single-shot per call (not auto-retried here): re-sending the SAME final status is
 * safe per the contract, so recovery/retries are the reporting service's job, not a
 * transport-level retry that could race. A DIFFERENT final status after one was
 * accepted returns HTTP 409 and is surfaced as `conflict` (the first result stays
 * authoritative; never overwrite it).
 */

export type FinalStatusOutcome =
  /** 2xx — the status was accepted (including a safe same-status re-send). */
  | 'sent'
  /** 409 — a different final status was already accepted; first wins, do not retry. */
  | 'conflict'
  /** Transport/permanent failure — retryable by the reporting service. */
  | 'failed';

export interface FinalStatusResult {
  outcome: FinalStatusOutcome;
  /** HTTP status when a response was received. */
  httpStatus?: number;
  /** Sanitized failure kind for logging/persistence (never a body/PII). */
  errorKind?: string;
}

export type CallInProgressOutcome =
  /** Guided Boost granted the one-time extension; `callBefore` is the NEW deadline. */
  | 'extended'
  /** Accepted, but no extension granted; `callBefore` (if present) is unchanged. */
  | 'not_extended'
  /** 409 — a resolved conflict (e.g. the lead is already finalized); do not retry. */
  | 'conflict'
  /** Transport/permanent failure — leave recoverable for the next monitor cycle. */
  | 'failed';

export interface CallInProgressResult {
  outcome: CallInProgressOutcome;
  /** The authoritative deadline Guided Boost returned, parsed, when present. */
  callBefore?: Date;
  httpStatus?: number;
  errorKind?: string;
}

export interface CallerStatusClientOptions {
  baseUrl?: string;
  apiKey?: string;
  agentEmail?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const statusPath = (leadId: string): string =>
  `/api/caller/leads/${encodeURIComponent(leadId)}/status`;

export class CallerStatusClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentEmail: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CallerStatusClientOptions = {}, config: Env = env) {
    this.baseUrl = options.baseUrl ?? config.CALLER_QUEUE_BASE_URL;
    this.apiKey = options.apiKey ?? requireLeadApiKey(config);
    this.agentEmail = options.agentEmail ?? config.CRM_AGENT_EMAIL;
    this.timeoutMs = options.timeoutMs ?? config.LEAD_API_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Reports one final status for a lead. Validates the request shape, posts it
   * with the caller auth identity, and classifies the response:
   *   - 2xx → `sent`
   *   - 409 → `conflict` (a different final already won; do not override/retry)
   *   - anything else / network → `failed` (retryable upstream)
   *
   * Never throws for an expected HTTP/network failure — returns a typed result so
   * the reporting service can persist retryable state without the webhook failing.
   */
  async reportFinalStatus(leadId: string, body: FinalStatusRequest): Promise<FinalStatusResult> {
    const payload = finalStatusRequestSchema.parse(body);
    const path = statusPath(leadId);
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          // Caller auth identity — attached here only; headers are never logged.
          'X-Lead-API-Key': this.apiKey,
          'X-Agent-Email': this.agentEmail,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      logger.warn(
        { leadId, timedOut },
        'caller status: request failed to complete; will be reported as retryable',
      );
      return { outcome: 'failed', errorKind: timedOut ? 'timeout' : 'network' };
    }

    if (response.status === 409) {
      // A different final status was already accepted. The first result is
      // authoritative; we must not override it or retry.
      logger.info({ leadId }, 'caller status: 409 — a different final status already accepted');
      return { outcome: 'conflict', httpStatus: 409 };
    }

    if (!response.ok) {
      return {
        outcome: 'failed',
        httpStatus: response.status,
        errorKind: classifyStatus(response.status),
      };
    }

    // Validate (tolerantly) but do not fail a 2xx on an unexpected extra field.
    try {
      finalStatusResponseSchema.parse(await response.json());
    } catch {
      /* a 2xx with an unexpected body is still an acceptance */
    }
    return { outcome: 'sent', httpStatus: response.status };
  }

  /**
   * Sends ONE `call_in_progress` near the deadline. Reads the extension response
   * `{ ok, extended, call_before }`:
   *   - 2xx + extended:true + a valid call_before → `extended` (callBefore = NEW deadline)
   *   - 2xx otherwise → `not_extended` (callBefore = the unchanged deadline, if returned)
   *   - 409 → `conflict` (resolved; the lead is already finalized on GB — do not retry)
   *   - anything else / network → `failed` (recoverable next cycle)
   *
   * Never throws for an expected HTTP/network failure. The caller (monitor) decides
   * persistence; this client never derives a deadline locally.
   */
  async reportCallInProgress(leadId: string): Promise<CallInProgressResult> {
    const path = statusPath(leadId);
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'X-Lead-API-Key': this.apiKey,
          'X-Agent-Email': this.agentEmail,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ status: 'call_in_progress' }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      logger.warn(
        { leadId, timedOut },
        'caller status: call_in_progress failed to complete; recoverable next cycle',
      );
      return { outcome: 'failed', errorKind: timedOut ? 'timeout' : 'network' };
    }

    if (response.status === 409) {
      logger.info({ leadId }, 'caller status: call_in_progress 409 — lead already finalized');
      return { outcome: 'conflict', httpStatus: 409 };
    }

    if (!response.ok) {
      return {
        outcome: 'failed',
        httpStatus: response.status,
        errorKind: classifyStatus(response.status),
      };
    }

    let parsed: ReturnType<typeof callInProgressResponseSchema.safeParse>;
    try {
      parsed = callInProgressResponseSchema.safeParse(await response.json());
    } catch {
      // A 2xx with an unreadable body: accepted, but no deadline to persist.
      return { outcome: 'not_extended', httpStatus: response.status };
    }

    if (!parsed.success) {
      return { outcome: 'not_extended', httpStatus: response.status };
    }

    const callBefore =
      typeof parsed.data.call_before === 'string' ? new Date(parsed.data.call_before) : undefined;

    if (parsed.data.extended === true && callBefore) {
      return { outcome: 'extended', callBefore, httpStatus: response.status };
    }
    return {
      outcome: 'not_extended',
      httpStatus: response.status,
      ...(callBefore ? { callBefore } : {}),
    };
  }
}

/** Re-export so callers get the error type without reaching into leadApi. */
export { LeadApiError };
