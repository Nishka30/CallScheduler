import { env, requireLeadApiKey, type Env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { classifyStatus, LeadApiError, sanitizeLeadApiPath } from '../leadApi/errors.js';
import { parseQueueResponse, type QueueLead } from './callerQueue.schemas.js';

/**
 * Focused client for the Guided Boost caller queue (`GET /api/caller/queue`).
 *
 * Reuses the EXISTING Lead API authentication: the caller key `LEAD_API_KEY_CALLER`
 * sent as `X-Lead-API-Key`. No new credential is introduced. The base URL is
 * `CALLER_QUEUE_BASE_URL` (defaults to the Lead API host). All HTTP concerns live
 * here, not in the worker.
 *
 * GET only, with the same bounded retry/backoff policy as the Lead API client
 * (429/5xx/network retried; auth/4xx/contract fail fast). The response is
 * validated at the boundary; an empty queue yields `null`.
 */

export interface CallerQueueClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so backoff does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const QUEUE_PATH = '/api/caller/queue';

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class CallerQueueClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CallerQueueClientOptions = {}, config: Env = env) {
    this.baseUrl = options.baseUrl ?? config.CALLER_QUEUE_BASE_URL;
    // Reuse the existing caller key; throws a clear, value-free error when absent.
    this.apiKey = options.apiKey ?? requireLeadApiKey(config);
    this.timeoutMs = options.timeoutMs ?? config.LEAD_API_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? config.LEAD_API_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * `GET /api/caller/queue` — returns the single offered `QueueLead`, or `null`
   * when the queue is empty. Validates the response at the boundary.
   */
  async fetchQueue(): Promise<QueueLead | null> {
    const payload = await this.getJson(QUEUE_PATH);
    return parseQueueResponse(payload);
  }

  private async getJson(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let lastError: LeadApiError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const delay = lastError?.retryAfterMs ?? backoffDelayMs(attempt);
        logger.warn(
          { path: sanitizeLeadApiPath(path), attempt, delayMs: delay, kind: lastError?.kind },
          'retrying caller queue request',
        );
        await this.sleep(delay);
      }

      try {
        return await this.performRequest(url, path);
      } catch (error) {
        if (!(error instanceof LeadApiError) || error.permanent) throw error;
        lastError = error;
      }
    }

    throw (
      lastError ??
      new LeadApiError('network', 'caller queue request failed with no recorded cause', { path })
    );
  }

  private async performRequest(url: string, path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          // The key is attached here and nowhere else. Headers are never logged.
          'X-Lead-API-Key': this.apiKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new LeadApiError(
        'network',
        timedOut
          ? `caller queue request timed out after ${String(this.timeoutMs)}ms`
          : 'caller queue request failed to complete',
        { path, cause: error },
      );
    }

    if (!response.ok) {
      throw new LeadApiError(
        classifyStatus(response.status),
        `caller queue returned ${String(response.status)}`,
        {
          status: response.status,
          path,
          ...parseRetryAfter(response.headers.get('retry-after')),
        },
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new LeadApiError('contract', 'caller queue returned a body that is not valid JSON', {
        status: response.status,
        path,
        cause: error,
      });
    }
  }
}

function parseRetryAfter(header: string | null): { retryAfterMs?: number } {
  if (!header) return {};
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryAfterMs: Math.min(seconds * 1_000, 60_000) };
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return { retryAfterMs: Math.max(0, Math.min(date - Date.now(), 60_000)) };
  }
  return {};
}

/** Exponential backoff with jitter: ~250ms, ~500ms, ~1s, capped at 8s. */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(250 * 2 ** (attempt - 1), 8_000);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}
