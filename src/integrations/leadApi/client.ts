import { env, requireLeadApiKey, type Env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { classifyStatus, LeadApiError, sanitizeLeadApiPath } from './errors.js';
import {
  apiErrorBodySchema,
  leadDetailSchema,
  LeadApiContractError,
  parseLeadListPage,
  personHistorySchema,
  type LeadDetail,
  type LeadListPage,
  type PersonHistory,
} from './schemas.js';

/** Query parameters for the incremental lead listing. */
export interface ListLeadsParams {
  /** ISO timestamp; selects leads changed since this moment. */
  since?: string;
  /** Opaque pagination cursor - exactly the `nextCursor` from the previous page. */
  cursor?: string;
  brand?: string;
  limit?: number;
}

export interface LeadApiClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so backoff does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Read-only client for the Lead API.
 *
 * Scope is deliberately narrow: **GET requests only**. The caller's key is
 * documented as read-only, and Phase 2 implements no CRM writes at all, so
 * there is no code path here that can issue a POST.
 */
export class LeadApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: LeadApiClientOptions = {}, config: Env = env) {
    this.baseUrl = options.baseUrl ?? config.LEAD_API_BASE_URL;
    // Throws a clear, value-free error when the key is absent.
    this.apiKey = options.apiKey ?? requireLeadApiKey(config);
    this.timeoutMs = options.timeoutMs ?? config.LEAD_API_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? config.LEAD_API_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * `GET /api/crm/leads` - leads changed since a time, oldest first by
   * `updated_at`.
   *
   * Returns both new and changed inquiries: the caller must decide eligibility
   * separately. `since` and `cursor` are distinct parameters and are never
   * substituted for one another.
   */
  async listLeads(params: ListLeadsParams = {}): Promise<LeadListPage> {
    const query = new URLSearchParams();
    if (params.since) query.set('since', params.since);
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.brand) query.set('brand', params.brand);
    if (params.limit !== undefined) query.set('limit', String(params.limit));

    const payload = await this.getJson('/api/crm/leads', query);

    try {
      return parseLeadListPage(payload);
    } catch (error) {
      if (error instanceof LeadApiContractError) {
        throw new LeadApiError('contract', error.message, { path: '/api/crm/leads', cause: error });
      }
      throw error;
    }
  }

  /** `GET /api/crm/leads/<id>` - one inquiry with corrections and answers. */
  async getLead(leadId: string): Promise<LeadDetail> {
    const path = `/api/crm/leads/${encodeURIComponent(leadId)}`;
    const payload = await this.getJson(path);

    const result = leadDetailSchema.safeParse(payload);
    if (!result.success) {
      throw new LeadApiError(
        'contract',
        'Lead detail response did not match the documented shape',
        {
          path: '/api/crm/leads/:id',
        },
      );
    }

    return result.data;
  }

  /**
   * `GET /api/crm/persons/<personKey>` - the person behind an inquiry.
   *
   * `personKey` is `email:<address>` or `lead:<id>` and must be URL-encoded;
   * the colon and any address characters are escaped by `encodeURIComponent`.
   */
  async getPerson(personKey: string): Promise<PersonHistory> {
    const path = `/api/crm/persons/${encodeURIComponent(personKey)}`;
    const payload = await this.getJson(path);

    const result = personHistorySchema.safeParse(payload);
    if (!result.success) {
      throw new LeadApiError(
        'contract',
        'Person history response did not match the documented shape',
        { path: '/api/crm/persons/:personKey' },
      );
    }

    return result.data;
  }

  /**
   * Performs a safe GET with bounded retries.
   *
   * Only 429, 5xx, and network failures are retried; auth, not-found, other
   * 4xx, and contract violations fail immediately because retrying them cannot
   * help. Backoff is exponential with jitter, and honours `Retry-After`.
   */
  private async getJson(path: string, query?: URLSearchParams): Promise<unknown> {
    const url = `${this.baseUrl}${path}${query && [...query].length > 0 ? `?${query.toString()}` : ''}`;

    let lastError: LeadApiError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const delay = lastError?.retryAfterMs ?? backoffDelayMs(attempt);
        logger.warn(
          { path: sanitizeLeadApiPath(path), attempt, delayMs: delay, kind: lastError?.kind },
          'retrying lead api request',
        );
        await this.sleep(delay);
      }

      try {
        return await this.performRequest(url, path);
      } catch (error) {
        if (!(error instanceof LeadApiError) || error.permanent) {
          throw error;
        }
        lastError = error;
      }
    }

    throw (
      lastError ??
      new LeadApiError('network', 'Lead API request failed with no recorded cause', { path })
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
          ? `Lead API request timed out after ${String(this.timeoutMs)}ms`
          : 'Lead API request failed to complete',
        { path, cause: error },
      );
    }

    if (!response.ok) {
      throw new LeadApiError(
        classifyStatus(response.status),
        `Lead API returned ${String(response.status)}${await describeErrorBody(response)}`,
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
      // Explicitly NOT treated as an empty page - that would silently skip leads.
      throw new LeadApiError('contract', 'Lead API returned a body that is not valid JSON', {
        status: response.status,
        path,
        cause: error,
      });
    }
  }
}

/**
 * Extracts the documented `{ "error": "..." }` message, if present.
 *
 * Only this one field is read: a whole error body may echo request data.
 */
async function describeErrorBody(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const parsed = apiErrorBodySchema.safeParse(body);
    return parsed.success ? `: ${parsed.data.error.slice(0, 200)}` : '';
  } catch {
    return '';
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
