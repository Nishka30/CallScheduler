import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadApiError } from '../src/integrations/leadApi/errors.js';
import { personHistorySchema } from '../src/integrations/leadApi/schemas.js';
import type { CalendarClient } from '../src/integrations/leadApi/calendar.client.js';
import type { LeadApiClient } from '../src/integrations/leadApi/client.js';
import type {
  BookingRequest,
  MatchedAppointment,
} from '../src/services/appointmentBooking.service.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const recordAppointment = vi.fn();
vi.mock('../src/repositories/appointmentRecord.repository.js', () => ({
  recordAppointment: (...args: unknown[]) => recordAppointment(...args),
  findLatestAppointmentForLead: vi.fn(),
}));

const { bookAppointment, reconcileTeamBooking } =
  await import('../src/services/appointmentBooking.service.js');

const TIMEOUT = new LeadApiError('network', 'timed out', { path: '/api/crm/appointments/team' });

/** A read-only Lead API client stub exposing only what the reconciler uses. */
function fakeLeadApi(
  over: Partial<Pick<LeadApiClient, 'getLead' | 'getPerson'>> = {},
): Pick<LeadApiClient, 'getLead' | 'getPerson'> {
  return {
    getLead: vi.fn(),
    getPerson: vi.fn(),
    ...over,
  };
}

const SLOT = {
  startsAt: '2026-11-03T14:15:00Z',
  endsAt: '2026-11-03T14:30:00Z',
  local: 'Tue 09:15',
};

function request(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    leadId: 'lead-1',
    mode: 'pool',
    chosenStartsAt: '2026-11-03T14:15:00Z',
    customerTz: 'America/Denver',
    meetingType: 'whatsapp',
    notes: 'Asked about October, party of 2',
    customerAgreed: true,
    offeredSlots: [SLOT],
    ...overrides,
  };
}

function fakeClient(
  result: unknown = {
    appointment: { id: 'appt_1', status: 'booked' },
    agent: { name: 'Ana', email: 'a@hw.com' },
    decision: { mode: 'pool' },
  },
) {
  const bookTeamAppointment =
    result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  return { client: { bookTeamAppointment } as unknown as CalendarClient, bookTeamAppointment };
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAppointment.mockResolvedValue({ id: 'local-1' });
});

describe('bookAppointment — pre-flight (no API call)', () => {
  it('refuses when the customer has not agreed', async () => {
    const { client, bookTeamAppointment } = fakeClient();
    expect((await bookAppointment(request({ customerAgreed: false }), { client })).outcome).toBe(
      'rejected_not_agreed',
    );
    expect(bookTeamAppointment).not.toHaveBeenCalled();
  });

  it('does not book when decision.mode is none', async () => {
    const { client, bookTeamAppointment } = fakeClient();
    expect((await bookAppointment(request({ mode: 'none' }), { client })).outcome).toBe(
      'routing_none',
    );
    expect(bookTeamAppointment).not.toHaveBeenCalled();
  });

  it('does not book when no slots were offered', async () => {
    const { client } = fakeClient();
    expect((await bookAppointment(request({ offeredSlots: [] }), { client })).outcome).toBe(
      'no_slots',
    );
  });

  it('rejects an invalid meeting type', async () => {
    const { client } = fakeClient();
    expect(
      (await bookAppointment(request({ meetingType: 'pigeon' as never }), { client })).outcome,
    ).toBe('invalid_meeting_type');
  });

  it('rejects a missing/invalid timezone', async () => {
    const { client } = fakeClient();
    expect((await bookAppointment(request({ customerTz: 'Denver' }), { client })).outcome).toBe(
      'invalid_timezone',
    );
  });

  it('rejects a slot that was not in the latest offered availability', async () => {
    const { client, bookTeamAppointment } = fakeClient();
    const r = await bookAppointment(request({ chosenStartsAt: '2026-12-25T10:00:00Z' }), {
      client,
    });
    expect(r.outcome).toBe('slot_not_offered');
    expect(bookTeamAppointment).not.toHaveBeenCalled();
  });
});

describe('bookAppointment — booking', () => {
  it('books via the team endpoint, persists, returns the agent name, and posts no note/email', async () => {
    const { client, bookTeamAppointment } = fakeClient();

    const r = await bookAppointment(request(), { client });

    expect(r).toEqual({ outcome: 'booked', appointmentId: 'appt_1', agentName: 'Ana' });
    expect(bookTeamAppointment).toHaveBeenCalledTimes(1);
    expect(recordAppointment).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: 'lead-1',
        appointmentId: 'appt_1',
        decisionMode: 'pool',
        agentEmail: 'a@hw.com',
      }),
    );
    // The team endpoint handles note + emails + assignment; nothing to duplicate.
  });

  it('never sends agent_email/customer_email in the request (team endpoint routes)', async () => {
    const { client, bookTeamAppointment } = fakeClient();
    await bookAppointment(request(), { client });
    const arg = bookTeamAppointment.mock.calls[0]![0];
    expect(arg).not.toHaveProperty('agentEmail');
    expect(arg).not.toHaveProperty('customerEmail');
  });

  it('maps a 409 to slot_conflict (refresh; never retry the same start)', async () => {
    const { client, bookTeamAppointment } = fakeClient(
      new LeadApiError('client', 'taken', { path: '/api/crm/appointments/team', status: 409 }),
    );
    const r = await bookAppointment(request(), { client });
    expect(r.outcome).toBe('slot_conflict');
    expect(bookTeamAppointment).toHaveBeenCalledTimes(1);
    expect(recordAppointment).not.toHaveBeenCalled();
  });

  it('maps a 403 to write_scope_disabled', async () => {
    const { client } = fakeClient(
      new LeadApiError('auth', 'forbidden', { path: '/x', status: 403 }),
    );
    expect((await bookAppointment(request(), { client })).outcome).toBe('write_scope_disabled');
  });

  it('treats a timeout as uncertain and does NOT resubmit', async () => {
    const { client, bookTeamAppointment } = fakeClient(
      new LeadApiError('network', 'timed out', { path: '/x' }),
    );
    // No reconcile dep and no leadApiClient → reconciler can't confirm, stays uncertain.
    const r = await bookAppointment(request(), {
      client,
      reconcile: () => Promise.resolve(null),
    });
    expect(r.outcome).toBe('uncertain');
    expect(bookTeamAppointment).toHaveBeenCalledTimes(1);
    expect(recordAppointment).not.toHaveBeenCalled();
  });
});

describe('bookAppointment — uncertain → read-only reconciliation (Fix A)', () => {
  const matched: MatchedAppointment = {
    appointmentId: 'appt_real',
    startsAt: '2026-11-03T14:15:00Z',
    status: 'booked',
    meetingType: 'video',
    agentName: 'Ana',
    agentEmail: 'a@hw.com',
  };

  it('(1) upgrades an uncertain write to booked and persists when reconciliation confirms', async () => {
    const { client, bookTeamAppointment } = fakeClient(TIMEOUT);
    const reconcile = vi.fn(() => Promise.resolve(matched));

    const r = await bookAppointment(request(), { client, reconcile });

    expect(r).toEqual({ outcome: 'booked', appointmentId: 'appt_real', agentName: 'Ana' });
    expect(bookTeamAppointment).toHaveBeenCalledTimes(1); // never resubmitted
    expect(recordAppointment).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: 'lead-1',
        appointmentId: 'appt_real',
        decisionMode: 'pool',
        agentEmail: 'a@hw.com',
      }),
    );
  });

  it('(2) preserves the uncertain response when reconciliation finds no match', async () => {
    const { client } = fakeClient(TIMEOUT);
    const r = await bookAppointment(request(), { client, reconcile: () => Promise.resolve(null) });
    expect(r.outcome).toBe('uncertain');
    expect(recordAppointment).not.toHaveBeenCalled();
  });

  it('(3) preserves uncertain (never throws, never claims success) when the reconcile read fails', async () => {
    const { client } = fakeClient(TIMEOUT);
    const r = await bookAppointment(request(), {
      client,
      reconcile: () => Promise.reject(new Error('person endpoint timed out again')),
    });
    expect(r.outcome).toBe('uncertain');
    expect(recordAppointment).not.toHaveBeenCalled();
  });
});

describe('reconcileTeamBooking — read-only match (Fix A)', () => {
  const booked = (over: Record<string, unknown>) => ({
    id: 'x',
    lead_id: 'lead-1',
    status: 'booked',
    starts_at: '2026-11-03T14:15:00+00:00',
    ...over,
  });

  it('(4) matches only the right lead + instant + booked status (no false positives)', async () => {
    const getPerson = vi.fn().mockResolvedValue({
      appointments: [
        booked({ id: 'other-lead', lead_id: 'someone-else' }), // wrong lead
        booked({ id: 'wrong-time', starts_at: '2026-11-04T09:00:00Z' }), // wrong instant
        booked({ id: 'not-booked', status: 'cancelled' }), // wrong status
        booked({ id: 'match', meeting_type: 'video', agent_name: 'Ana', agent_email: 'a@hw.com' }),
      ],
    });
    const leadApi = fakeLeadApi({ getPerson });

    const r = await reconcileTeamBooking(
      // '…Z' vs the entry's '+00:00' is the same instant — matching must normalise.
      { leadId: 'lead-1', startsAt: '2026-11-03T14:15:00.000Z', personKey: 'person:1' },
      { leadApiClient: leadApi },
    );

    expect(r?.appointmentId).toBe('match');
    expect(r?.agentName).toBe('Ana');
    expect(leadApi.getLead).not.toHaveBeenCalled(); // personKey supplied → no extra lookup
  });

  it('returns null when no appointment matches', async () => {
    const getPerson = vi.fn().mockResolvedValue({
      appointments: [booked({ id: 'wrong', starts_at: '2026-12-01T09:00:00Z' })],
    });
    const r = await reconcileTeamBooking(
      { leadId: 'lead-1', startsAt: '2026-11-03T14:15:00Z', personKey: 'person:1' },
      { leadApiClient: fakeLeadApi({ getPerson }) },
    );
    expect(r).toBeNull();
  });

  it('resolves the person key from the lead detail when not supplied', async () => {
    const getLead = vi.fn().mockResolvedValue({ personKey: 'person:resolved' });
    const getPerson = vi.fn().mockResolvedValue({ appointments: [booked({ id: 'match' })] });
    const leadApi = fakeLeadApi({ getLead, getPerson });

    const r = await reconcileTeamBooking(
      { leadId: 'lead-1', startsAt: '2026-11-03T14:15:00Z' },
      { leadApiClient: leadApi },
    );

    expect(getLead).toHaveBeenCalledWith('lead-1');
    expect(getPerson).toHaveBeenCalledWith('person:resolved');
    expect(r?.appointmentId).toBe('match');
  });

  it('returns null (never throws) when the person read fails', async () => {
    const getPerson = vi
      .fn()
      .mockRejectedValue(new LeadApiError('network', 'timeout', { path: '/p' }));
    const r = await reconcileTeamBooking(
      { leadId: 'lead-1', startsAt: '2026-11-03T14:15:00Z', personKey: 'person:1' },
      { leadApiClient: fakeLeadApi({ getPerson }) },
    );
    expect(r).toBeNull();
  });
});

describe('personHistorySchema — appointments[] shape (Fix A, regression)', () => {
  it('(6) parses the real appointments[] shape and coerces ids to strings', () => {
    const parsed = personHistorySchema.safeParse({
      bookings: [],
      appointments: [
        {
          id: 123, // numeric id coerces to string
          lead_id: '7b4f404d-6a0b-4e90-80e7-8d59295baed6',
          starts_at: '2026-10-27T20:45:00+00:00',
          ends_at: '2026-10-27T21:00:00+00:00',
          status: 'booked',
          meeting_type: 'video',
          customer_tz: 'America/Los_Angeles',
          booked_by: 'caller',
          agent_email: 'agent@example.com',
          agent_name: 'Agent Example',
          google_event_id: 'kept-by-passthrough',
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const appt = parsed.data.appointments?.[0];
    expect(appt?.id).toBe('123');
    expect(appt?.lead_id).toBe('7b4f404d-6a0b-4e90-80e7-8d59295baed6');
    expect(appt?.status).toBe('booked');
  });

  it('stays tolerant: a malformed appointment entry never breaks person parsing', () => {
    const parsed = personHistorySchema.safeParse({
      appointments: [{ unexpected: true }], // no id/lead_id/etc.
    });
    expect(parsed.success).toBe(true);
  });
});
