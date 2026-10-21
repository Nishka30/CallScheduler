import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarClient } from '../src/integrations/leadApi/calendar.client.js';
import type { LeadApiError } from '../src/integrations/leadApi/errors.js';
import { parseEnv } from '../src/config/env.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const KEY = 'lead-key-never-real';

function config(overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    LEAD_API_KEY_CALLER: KEY,
    LEAD_API_MAX_RETRIES: '1',
    CRM_AGENT_EMAIL: 'ai-caller@himalayanwonders.com',
    CRM_AGENT_NAME: 'AI Caller',
    ...overrides,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function stubFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: href, init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected extra fetch call');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, overrides: Record<string, string> = {}) {
  return new CalendarClient({ fetchImpl, sleep: () => Promise.resolve() }, config(overrides));
}

async function rejection(p: Promise<unknown>): Promise<LeadApiError> {
  try {
    await p;
  } catch (e) {
    return e as LeadApiError;
  }
  throw new Error('expected rejection');
}

const TEAM_SLOTS = {
  lead_id: 'lead-1',
  brand: 'himalayanwonders.com',
  decision: { mode: 'pool', fallback: false, reason: 'pool' },
  owner: null,
  agents: [{ email: 'a@hw.com', name: 'Ana' }],
  slots: [
    {
      starts_at: '2026-11-03T14:15:00Z',
      ends_at: '2026-11-03T14:30:00Z',
      agents: ['a@hw.com'],
      local: 'Tue 09:15',
    },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('getTeamSlots', () => {
  it('GETs the per-lead team-slots endpoint with tz and parses decision + slots', async () => {
    const { impl, calls } = stubFetch(jsonResponse(TEAM_SLOTS));

    const res = await client(impl).getTeamSlots('lead-1', 'America/Denver', { from: 'A', to: 'B' });

    expect(res.decision.mode).toBe('pool');
    expect(res.slots[0]!.starts_at).toBe('2026-11-03T14:15:00Z');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/crm/leads/lead-1/team-slots');
    expect(url.searchParams.get('tz')).toBe('America/Denver');
    expect(url.searchParams.get('from')).toBe('A');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Lead-API-Key']).toBe(KEY);
    // A read carries no write identity.
    expect(headers['X-Agent-Email']).toBeUndefined();
    expect(headers['X-Agent-Name']).toBeUndefined();
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('retries a 5xx on this safe GET', async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({ error: 'boom' }, { status: 500 }),
      jsonResponse(TEAM_SLOTS),
    );
    await client(impl).getTeamSlots('lead-1', 'UTC');
    expect(calls).toHaveLength(2);
  });
});

describe('bookTeamAppointment (write)', () => {
  const input = {
    leadId: 'lead-1',
    startsAt: '2026-11-03T14:15:00Z',
    meetingType: 'whatsapp' as const,
    customerTz: 'America/Denver',
    notes: 'Asked about October, party of 2',
  };
  const ok = jsonResponse(
    {
      appointment: { id: 'appt_1', status: 'booked' },
      agent: { name: 'Ana', email: 'a@hw.com' },
      decision: { mode: 'pool' },
      free_agents: [],
    },
    { status: 201 },
  );

  it('POSTs /appointments/team with booked_by:caller and BOTH write headers', async () => {
    const { impl, calls } = stubFetch(ok);

    const res = await client(impl).bookTeamAppointment(input);

    expect(res.appointment.id).toBe('appt_1');
    expect(res.agent?.name).toBe('Ana');
    expect(calls[0]!.url).toContain('/api/crm/appointments/team');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Lead-API-Key']).toBe(KEY);
    expect(headers['X-Agent-Email']).toBe('ai-caller@himalayanwonders.com');
    expect(headers['X-Agent-Name']).toBe('AI Caller');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({
      lead_id: 'lead-1',
      starts_at: '2026-11-03T14:15:00Z',
      meeting_type: 'whatsapp',
      customer_tz: 'America/Denver',
      notes: 'Asked about October, party of 2',
      booked_by: 'caller',
    });
    // The brief's team body carries no agent_email / customer_email / customer_phone.
    expect(body).not.toHaveProperty('agent_email');
    expect(body).not.toHaveProperty('customer_email');
  });

  it('is single-shot: a 5xx is NOT retried', async () => {
    const { impl, calls } = stubFetch(jsonResponse({ error: 'boom' }, { status: 500 }));
    await rejection(client(impl).bookTeamAppointment(input));
    expect(calls).toHaveLength(1);
  });

  it('surfaces 403 (scope) and 409 (slot taken) with status', async () => {
    const e403 = await rejection(
      client(stubFetch(jsonResponse({ error: 'f' }, { status: 403 })).impl).bookTeamAppointment(
        input,
      ),
    );
    expect(e403.status).toBe(403);
    const e409 = await rejection(
      client(stubFetch(jsonResponse({ error: 't' }, { status: 409 })).impl).bookTeamAppointment(
        input,
      ),
    );
    expect(e409.status).toBe(409);
  });

  it('rejects a 201 without an appointment id as a contract error', async () => {
    const { impl } = stubFetch(jsonResponse({ agent: { name: 'Ana' } }, { status: 201 }));
    expect((await rejection(client(impl).bookTeamAppointment(input))).kind).toBe('contract');
  });
});

describe('updateAppointment (PATCH)', () => {
  it('reschedules and cancels with cancel_reason', async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({ id: 'appt_1', status: 'rescheduled' }),
      jsonResponse({ id: 'appt_1', status: 'cancelled' }),
    );
    const c = client(impl);
    await c.updateAppointment('appt_1', { startsAt: '2026-11-04T10:00:00Z' });
    await c.updateAppointment('appt_1', { status: 'cancelled', cancelReason: 'customer asked' });
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      status: 'cancelled',
      cancel_reason: 'customer asked',
    });
  });
});

describe('no-booking writes', () => {
  it('posts one lead note with the write identity', async () => {
    const { impl, calls } = stubFetch(jsonResponse({ ok: true }, { status: 201 }));
    await client(impl).postLeadNote('lead-1', {
      note: 'Wants a call next week',
      noteStatus: 'Callback',
    });
    expect(calls[0]!.url).toContain('/api/crm/leads/lead-1/notes');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Agent-Email']).toBe('ai-caller@himalayanwonders.com');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      note: 'Wants a call next week',
      note_status: 'Callback',
    });
  });

  it('forwards via the public endpoint with NO auth/agent headers', async () => {
    const { impl, calls } = stubFetch(jsonResponse({ ok: true }));
    await client(impl).forwardLead('lead-1');
    expect(calls[0]!.url).toContain('/api/public/lead-forward');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Lead-API-Key']).toBeUndefined();
    expect(headers['X-Agent-Email']).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ lead_id: 'lead-1' });
  });
});
