import { env, requireLeadApiKey, type Env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { classifyStatus, LeadApiError } from './errors.js';
import {
  parseTeamSlots,
  parseTeamAppointment,
  parseAppointmentPatch,
  type MeetingType,
  type TeamAppointmentResponse,
  type TeamSlotsResponse,
} from './calendar.schemas.js';

export interface BookTeamAppointmentInput {
  leadId: string;
  /** UTC instant from a team slot's `starts_at` — never a locally computed time. */
  startsAt: string;
  meetingType: MeetingType;
  customerTz: string;
  /** Everything learned on the call (no card/passport/payment data). */
  notes: string;
}

export interface UpdateAppointmentInput {
  startsAt?: string;
  status?: 'cancelled';
  cancelReason?: string;
}

export interface PostNoteInput {
  note: string;
  noteStatus?: string;
  nextFollowup?: string;
}

export interface CalendarClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Client for the Lead API **team** calendar workflow (Oct 20 brief) plus the
 * no-booking actions (note, legacy forward).
 *
 * Reuses the Lead API base URL + `X-Lead-API-Key`. Authorised CRM writes
 * (`POST`/`PATCH`) also send BOTH `X-Agent-Email` and `X-Agent-Name` (the caller
 * identity, from config). Writes are **single-shot** — booking is not
 * idempotent, so a retry could double-book. GETs are retried on 429/5xx/network.
 *
 * The caller NEVER assigns a lead or changes its status: there is no
 * `/assignment` or `/status` method here. A booking's assignment is handled
 * server-side (the agent lands in the previous-owner fields).
 */
export class CalendarClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentEmail: string;
  private readonly agentName: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CalendarClientOptions = {}, config: Env = env) {
    this.baseUrl = config.LEAD_API_BASE_URL;
    this.apiKey = requireLeadApiKey(config);
    this.agentEmail = config.CRM_AGENT_EMAIL;
    this.agentName = config.CRM_AGENT_NAME;
    this.timeoutMs = config.LEAD_API_TIMEOUT_MS;
    this.maxRetries = config.LEAD_API_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** `GET /api/crm/leads/<id>/team-slots?tz=&from=&to=` — pooled/owner availability. */
  async getTeamSlots(
    leadId: string,
    tz: string,
    range: { from?: string; to?: string } = {},
  ): Promise<TeamSlotsResponse> {
    const query = new URLSearchParams({ tz });
    if (range.from) query.set('from', range.from);
    if (range.to) query.set('to', range.to);
    const path = `/api/crm/leads/${encodeURIComponent(leadId)}/team-slots`;
    return parseTeamSlots(await this.getJson(path, query), path);
  }

  /** `POST /api/crm/appointments/team` — books with owner-first / rotation server-side. */
  async bookTeamAppointment(input: BookTeamAppointmentInput): Promise<TeamAppointmentResponse> {
    const body = {
      lead_id: input.leadId,
      starts_at: input.startsAt,
      meeting_type: input.meetingType,
      customer_tz: input.customerTz,
      notes: input.notes,
      booked_by: 'caller',
    };
    const path = '/api/crm/appointments/team';
    const appt = parseTeamAppointment(await this.write('POST', path, body), path);
    logger.info({ appointmentId: appt.appointment.id }, 'calendar: team appointment booked');
    return appt;
  }

  /** `PATCH /api/crm/appointments/<id>` — reschedule (`startsAt`) or cancel (`status`). */
  async updateAppointment(id: string, input: UpdateAppointmentInput) {
    const body: Record<string, unknown> = {
      ...(input.startsAt === undefined ? {} : { starts_at: input.startsAt }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.cancelReason === undefined ? {} : { cancel_reason: input.cancelReason }),
    };
    const path = `/api/crm/appointments/${encodeURIComponent(id)}`;
    return parseAppointmentPatch(await this.write('PATCH', path, body), path);
  }

  /** `POST /api/crm/leads/<id>/notes` — the one note for a no-booking outcome. */
  async postLeadNote(leadId: string, input: PostNoteInput): Promise<void> {
    const body: Record<string, unknown> = {
      note: input.note,
      ...(input.noteStatus === undefined ? {} : { note_status: input.noteStatus }),
      ...(input.nextFollowup === undefined ? {} : { next_followup: input.nextFollowup }),
    };
    await this.write('POST', `/api/crm/leads/${encodeURIComponent(leadId)}/notes`, body);
  }

  /**
   * `POST /api/public/lead-forward` — forward a declining lead to the legacy
   * centre now instead of waiting for the timer. Public endpoint: sent with no
   * key or agent headers.
   */
  async forwardLead(leadId: string): Promise<void> {
    await this.request(
      'POST',
      `${this.baseUrl}/api/public/lead-forward`,
      '/api/public/lead-forward',
      {
        body: { lead_id: leadId },
        publicNoAuth: true,
      },
    );
  }

  // -------------------------------------------------------------------------

  private async getJson(path: string, query: URLSearchParams): Promise<unknown> {
    const url = `${this.baseUrl}${path}?${query.toString()}`;
    let lastError: LeadApiError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) await this.sleep(backoffDelayMs(attempt));
      try {
        return await this.request('GET', url, path);
      } catch (error) {
        if (!(error instanceof LeadApiError) || error.permanent) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new LeadApiError('network', 'calendar GET failed', { path });
  }

  /** Single-shot write (never retried: booking is not idempotent). */
  private async write(
    method: 'POST' | 'PATCH',
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(method, `${this.baseUrl}${path}`, path, { body });
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    path: string,
    options: { body?: Record<string, unknown>; publicNoAuth?: boolean } = {},
  ): Promise<unknown> {
    const isWrite = method !== 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!options.publicNoAuth) headers['X-Lead-API-Key'] = this.apiKey;
    if (isWrite && !options.publicNoAuth) {
      // The caller's fixed write identity, required on every authorised CRM write.
      headers['X-Agent-Email'] = this.agentEmail;
      headers['X-Agent-Name'] = this.agentName;
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new LeadApiError(
        'network',
        timedOut
          ? `calendar request timed out after ${String(this.timeoutMs)}ms`
          : 'calendar request failed',
        { path, cause: error },
      );
    }

    if (!response.ok) {
      throw new LeadApiError(
        classifyStatus(response.status),
        `calendar ${method} ${path} returned ${String(response.status)}${await describeErrorBody(response)}`,
        { status: response.status, path },
      );
    }

    try {
      return await response.json();
    } catch {
      // Some writes (note/forward) may return an empty body; that is fine.
      return null;
    }
  }
}

async function describeErrorBody(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === 'object' &&
      typeof (body as { error?: unknown }).error === 'string'
    ) {
      return `: ${(body as { error: string }).error.slice(0, 200)}`;
    }
  } catch {
    /* ignore */
  }
  return '';
}

function backoffDelayMs(attempt: number): number {
  const base = Math.min(250 * 2 ** (attempt - 1), 8_000);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}
