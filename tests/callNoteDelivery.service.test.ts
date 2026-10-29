import { describe, expect, it, vi } from 'vitest';
import type { CallRecord } from '@prisma/client';
import { LeadApiError } from '../src/integrations/leadApi/errors.js';
import type { CallNoteAppointment } from '../src/services/callNote.service.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const { deliverCallNote } = await import('../src/services/callNoteDelivery.service.js');

function record(over: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
    leadId: 'lead-1',
    personKey: null,
    retellCallId: 'call_abc',
    status: 'COMPLETED',
    outcome: 'NOT_INTERESTED',
    summary: 'Declined politely.',
    startedAt: new Date('2026-10-30T09:00:00.000Z'),
    endedAt: new Date('2026-10-30T09:04:00.000Z'),
    transcript: 'Agent: Hi\nUser: Not interested',
    transcriptJson: null,
    analysis: null,
    recordingUrl: null,
    disconnectionReason: null,
    direction: 'outbound',
    customerTz: 'America/Denver',
    agentId: null,
    agentVersion: null,
    transcriptWithToolCalls: null,
    recordingMultiChannelUrl: null,
    publicLogUrl: null,
    providerMetadata: null,
    noteStatus: null,
    noteError: null,
    noteAttempts: 0,
    noteLastAttemptAt: null,
    noteDeliveredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const appointment: CallNoteAppointment = {
  appointmentId: 'appt_9',
  startsAt: new Date('2026-11-02T17:00:00.000Z'),
  status: 'booked',
  meetingType: 'video',
  agentEmail: 'agent@example.com',
  decisionMode: 'owner',
};

function deps(over: Record<string, unknown> = {}) {
  return {
    client: { postCallNote: vi.fn((_leadId: string, _note: string) => Promise.resolve()) },
    findAppointment: vi.fn(() => Promise.resolve(null)),
    markDelivered: vi.fn(() => Promise.resolve()),
    markFailed: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

describe('deliverCallNote', () => {
  it('delivers the note for a non-booking outcome and marks it sent', async () => {
    const d = deps();
    const res = await deliverCallNote(record(), d);

    expect(res).toBe('sent');
    expect(d.client.postCallNote).toHaveBeenCalledTimes(1);
    const [leadId, note] = d.client.postCallNote.mock.calls[0]!;
    expect(leadId).toBe('lead-1');
    expect(String(note)).toContain('Outcome: declined');
    expect(d.markDelivered).toHaveBeenCalledWith('call-1');
    expect(d.markFailed).not.toHaveBeenCalled();
  });

  it('includes confirmed appointment details for a booked call', async () => {
    const d = deps({ findAppointment: vi.fn(() => Promise.resolve(appointment)) });
    await deliverCallNote(record({ outcome: 'APPOINTMENT_BOOKED' }), d);
    const note = String(d.client.postCallNote.mock.calls[0]![1]);
    expect(note).toContain('Outcome: booked');
    expect(note).toContain('appt_9');
  });

  it('records a failure WITHOUT throwing and without losing the local record', async () => {
    const d = deps({
      client: {
        postCallNote: vi.fn(() =>
          Promise.reject(new LeadApiError('server', 'boom', { path: '/x', status: 503 })),
        ),
      },
    });

    const res = await deliverCallNote(record(), d);

    expect(res).toBe('failed');
    expect(d.markFailed).toHaveBeenCalledWith('call-1', 'server 503');
    expect(d.markDelivered).not.toHaveBeenCalled();
  });

  it('is single-shot and never re-sends a note already delivered', async () => {
    const d = deps();
    const res = await deliverCallNote(record({ noteStatus: 'sent' }), d);
    expect(res).toBe('already_sent');
    expect(d.client.postCallNote).not.toHaveBeenCalled();
  });

  it('posts the note exactly once (no retry loop → no duplicate-note / re-book risk)', async () => {
    const d = deps();
    await deliverCallNote(record({ outcome: 'APPOINTMENT_BOOKED' }), d);
    // One write only; delivery never books or re-books (it has no booking path).
    expect(d.client.postCallNote).toHaveBeenCalledTimes(1);
  });
});
