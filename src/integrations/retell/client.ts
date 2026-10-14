import {
  env,
  requireRetellCallingEnabled,
  requireRetellConfig,
  type Env,
  type RetellConfig,
} from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { classifyStatus, RetellApiError } from './errors.js';
import {
  createPhoneCallResponseSchema,
  retellErrorBodySchema,
  type CreatePhoneCallResult,
} from './schemas.js';

/** E.164, matching the validation used elsewhere in the project. */
const E164 = /^\+[1-9]\d{6,14}$/;

const CREATE_CALL_PATH = '/v2/create-phone-call';

export interface CreatePhoneCallParams {
  /** Destination in E.164. Must already be the validated number, not a raw field. */
  toNumber: string;
  /**
   * Idempotency key passed to Retell so an accidental duplicate submit for the
   * same attempt cannot place a second call. Use the local `CallRecord.id`.
   */
  idempotencyKey?: string;
  /**
   * Opaque correlation data echoed back by Retell (and in webhooks), e.g.
   * `{ leadId, callRecordId }`. Values are strings; never put PII here beyond
   * our own opaque ids.
   */
  metadata?: Record<string, string>;
  /**
   * Dynamic variables injected into the agent's prompt. Supply ONLY keys that
   * match the configured agent's prompt - the client does not invent a mapping
   * from lead context, because the agent's prompt variable names are not
   * confirmed. Omitted entirely when not provided.
   */
  dynamicVariables?: Record<string, string>;
}

export interface RetellClientOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Minimal, isolated client for Retell outbound calls.
 *
 * Scope is deliberately narrow: the one call-initiation endpoint, nothing else.
 * It never touches the CRM and has no read methods.
 *
 * **Single-shot, never retried.** Creating a phone call is not idempotent at the
 * transport level, so a timeout or 5xx after the request left the process may
 * mean the call was already placed. Retrying could dial a real customer twice.
 * On any uncertain failure the client raises a `RetellApiError` with
 * `uncertain === true` and lets the caller reconcile, rather than retrying.
 */
export class RetellClient {
  private readonly config: Env;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RetellClientOptions = {}, config: Env = env) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Places one outbound call via `POST /v2/create-phone-call`.
   *
   * Pre-flight guards run in this order, all BEFORE any network request:
   *   1. calling must be enabled (master switch),
   *   2. config (key / from-number / agent id) must be present and valid,
   *   3. the destination must be a well-formed E.164 number.
   *
   * Returns the provider call id and a safe subset of the response.
   */
  async createPhoneCall(params: CreatePhoneCallParams): Promise<CreatePhoneCallResult> {
    // 1. Master switch. Refuse before touching config, the network, or anything.
    try {
      requireRetellCallingEnabled(this.config);
    } catch (error) {
      throw new RetellApiError('disabled', (error as Error).message, { path: CREATE_CALL_PATH });
    }

    // 2. Credentials and agent config.
    let cfg: RetellConfig;
    try {
      cfg = requireRetellConfig(this.config);
    } catch (error) {
      throw new RetellApiError('config', (error as Error).message, { path: CREATE_CALL_PATH });
    }

    // 3. Destination number. Only the validated E.164 value may ever be dialled.
    const toNumber = params.toNumber.trim();
    if (!E164.test(toNumber)) {
      throw new RetellApiError(
        'invalid_destination',
        'Destination number is not a valid E.164 number; refusing to place a call.',
        { path: CREATE_CALL_PATH },
      );
    }

    const body: Record<string, unknown> = {
      from_number: cfg.fromNumber,
      to_number: toNumber,
      override_agent_id: cfg.agentId,
      ...(params.idempotencyKey === undefined ? {} : { idempotency_key: params.idempotencyKey }),
      ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      ...(params.dynamicVariables === undefined
        ? {}
        : { retell_llm_dynamic_variables: params.dynamicVariables }),
    };

    const result = await this.postCreateCall(cfg, body);

    // Safe log: ids and provider status only. Never the destination number.
    logger.info(
      {
        callId: result.callId,
        agentId: result.agentId,
        agentName: cfg.agentName,
        callStatus: result.callStatus,
      },
      'retell outbound call created',
    );

    return result;
  }

  private async postCreateCall(
    cfg: RetellConfig,
    body: Record<string, unknown>,
  ): Promise<CreatePhoneCallResult> {
    const url = `${cfg.baseUrl}${CREATE_CALL_PATH}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          // The bearer key is attached here and nowhere else. Headers are never logged.
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      // UNCERTAIN: the request may have reached Retell and placed the call.
      throw new RetellApiError(
        'network',
        timedOut
          ? `Retell request timed out after ${String(cfg.timeoutMs)}ms; call status is UNKNOWN and must be reconciled.`
          : 'Retell request failed to complete; call status is UNKNOWN and must be reconciled.',
        { path: CREATE_CALL_PATH, cause: error },
      );
    }

    if (!response.ok) {
      throw new RetellApiError(
        classifyStatus(response.status),
        `Retell create-call returned ${String(response.status)}${await describeErrorBody(response)}`,
        { status: response.status, path: CREATE_CALL_PATH },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new RetellApiError('contract', 'Retell returned a body that is not valid JSON', {
        status: response.status,
        path: CREATE_CALL_PATH,
        cause: error,
      });
    }

    const parsed = createPhoneCallResponseSchema.safeParse(payload);
    if (!parsed.success) {
      // Most importantly: a 2xx with no call_id is NOT a success.
      throw new RetellApiError(
        'contract',
        'Retell create-call response did not include a call_id',
        { status: response.status, path: CREATE_CALL_PATH },
      );
    }

    const agentId = parsed.data.agent_id ?? undefined;
    const callStatus = parsed.data.call_status ?? undefined;

    return {
      callId: parsed.data.call_id,
      ...(agentId === undefined ? {} : { agentId }),
      ...(callStatus === undefined ? {} : { callStatus }),
    };
  }
}

/**
 * Extracts a short provider error message if present. Only the message field is
 * read - a whole error body could echo request data.
 */
async function describeErrorBody(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const parsed = retellErrorBodySchema.safeParse(body);
    if (!parsed.success) return '';
    const message = parsed.data.error_message ?? parsed.data.message;
    return message ? `: ${message.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}
