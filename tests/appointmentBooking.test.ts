import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadApiError } from '../src/integrations/leadApi/errors.js';
import type { CalendarClient } from '../src/integrations/leadApi/calendar.client.js';
import type { BookingRequest } from '../src/services/appointmentBooking.service.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const recordAppointment = vi.fn();
vi.mock('../src/repositories/appointmentRecord.repository.js', () => ({
  recordAppointment: (...args: unknown[]) => recordAppointment(...args),
  findLatestAppointmentForLead: vi.fn(),
}));

const { bookAppointment } = await import('../src/services/appointmentBooking.service.js');

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
    const r = await bookAppointment(request(), { client });
    expect(r.outcome).toBe('uncertain');
    expect(bookTeamAppointment).toHaveBeenCalledTimes(1);
    expect(recordAppointment).not.toHaveBeenCalled();
  });
});
