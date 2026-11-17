import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const recordLifecycleEvent = vi.fn();
const listLifecycleEventsByLead = vi.fn();
vi.mock('../src/repositories/leadLifecycle.repository.js', () => ({
  recordLifecycleEvent: (...a: unknown[]) => recordLifecycleEvent(...a),
  listLifecycleEventsByLead: (...a: unknown[]) => listLifecycleEventsByLead(...a),
}));

const findByLeadId = vi.fn();
vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  findByLeadId: (...a: unknown[]) => findByLeadId(...a),
}));

const getLatestCallRecordByLead = vi.fn();
vi.mock('../src/repositories/callRecord.repository.js', () => ({
  getLatestCallRecordByLead: (...a: unknown[]) => getLatestCallRecordByLead(...a),
  listLatestCallRecordsForLeads: vi.fn(() => Promise.resolve([])),
}));

// Default: no appointment (not booked). Individual tests can override.
const findLatestAppointmentForLead = vi.fn(() => Promise.resolve(null));
vi.mock('../src/repositories/appointmentRecord.repository.js', () => ({
  findLatestAppointmentForLead: (...a: unknown[]) => findLatestAppointmentForLead(...a),
  listBookedLeadIds: vi.fn(() => Promise.resolve(new Set())),
}));

const {
  recordLifecycle,
  getLeadLifecycleTrace,
  holdRemainingLabel,
  LifecycleEvent,
  LifecycleStatus,
} = await import('../src/services/leadLifecycle.service.js');

afterEach(() => {
  recordLifecycleEvent.mockReset();
  listLifecycleEventsByLead.mockReset();
  findByLeadId.mockReset();
  getLatestCallRecordByLead.mockReset();
});

describe('recordLifecycle (best effort)', () => {
  it('persists an event and returns true', async () => {
    recordLifecycleEvent.mockResolvedValue({ id: 'e1' });
    const ok = await recordLifecycle({
      leadId: 'lead-1',
      event: LifecycleEvent.LEAD_RECEIVED,
      status: LifecycleStatus.RECEIVED,
    });
    expect(ok).toBe(true);
    expect(recordLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-1', event: 'lead_received', status: 'RECEIVED' }),
    );
  });

  it('never throws when the write fails; returns false', async () => {
    recordLifecycleEvent.mockRejectedValue(new Error('db down'));
    const ok = await recordLifecycle({ leadId: 'lead-2', event: LifecycleEvent.LEAD_DECISION });
    expect(ok).toBe(false);
  });
});

describe('holdRemainingLabel', () => {
  const now = Date.parse('2026-11-14T10:00:00.000Z');
  it('formats remaining time', () => {
    expect(holdRemainingLabel('2026-11-14T10:06:42.000Z', now)).toBe('6m 42s');
  });
  it('returns "expired" for a past hold', () => {
    expect(holdRemainingLabel('2026-11-14T09:59:00.000Z', now)).toBe('expired');
  });
  it('returns null for missing/invalid input', () => {
    expect(holdRemainingLabel(null, now)).toBeNull();
    expect(holdRemainingLabel('not-a-date', now)).toBeNull();
  });
});

describe('getLeadLifecycleTrace', () => {
  it('returns null lead and no events when nothing is known', async () => {
    findByLeadId.mockResolvedValue(null);
    listLifecycleEventsByLead.mockResolvedValue([]);
    getLatestCallRecordByLead.mockResolvedValue(null);
    const trace = await getLeadLifecycleTrace('missing');
    expect(trace).toEqual({ lead: null, events: [] });
  });

  it('returns events in the order the repository provides, as ISO strings', async () => {
    findByLeadId.mockResolvedValue({
      status: 'SKIPPED',
      decisionReason: 'crm_route_excluded',
      decisionDetail: 'crm_route=legacy',
      attemptCount: 0,
      decidedAt: new Date('2026-11-14T10:00:06.000Z'),
      nextRetryAt: null,
      createdAt: new Date('2026-11-14T10:00:04.000Z'),
      updatedAt: new Date('2026-11-14T10:00:06.000Z'),
    });
    getLatestCallRecordByLead.mockResolvedValue(null);
    listLifecycleEventsByLead.mockResolvedValue([
      {
        id: 'e1',
        event: 'lead_received',
        status: 'RECEIVED',
        reason: null,
        detail: null,
        metadata: { crmRoute: null },
        createdAt: new Date('2026-11-14T10:00:04.000Z'),
      },
      {
        id: 'e2',
        event: 'crm_gate_checked',
        status: 'rejected',
        reason: 'crm_route_excluded',
        detail: 'legacy',
        metadata: { crmRoute: 'legacy', callerHoldUntil: '2026-11-14T10:10:00.000Z' },
        createdAt: new Date('2026-11-14T10:00:06.000Z'),
      },
    ]);

    const trace = await getLeadLifecycleTrace('lead-x');
    expect(trace.events.map((e) => e.event)).toEqual(['lead_received', 'crm_gate_checked']);
    expect(trace.events[0]!.createdAt).toBe('2026-11-14T10:00:04.000Z');
    // latest-known routing/hold are derived from event metadata
    expect(trace.lead?.crmRoute).toBe('legacy');
    expect(trace.lead?.callerHoldUntil).toBe('2026-11-14T10:10:00.000Z');
    expect(trace.lead?.status).toBe('SKIPPED');
    expect(trace.lead?.decisionReason).toBe('crm_route_excluded');
  });

  it('includes the latest call record summary when one exists', async () => {
    findByLeadId.mockResolvedValue(null);
    listLifecycleEventsByLead.mockResolvedValue([
      { id: 'e1', event: 'retell_initiated', status: 'INITIATED', reason: null, detail: null, metadata: {}, createdAt: new Date('2026-11-14T10:00:08.000Z') },
    ]);
    getLatestCallRecordByLead.mockResolvedValue({
      id: 'c1',
      retellCallId: 'call_abc',
      status: 'COMPLETED',
      outcome: 'APPOINTMENT_BOOKED',
      startedAt: new Date('2026-11-14T10:00:08.000Z'),
      endedAt: new Date('2026-11-14T10:03:21.000Z'),
    });
    const trace = await getLeadLifecycleTrace('lead-c');
    expect(trace.lead?.call).toMatchObject({
      callRecordId: 'c1',
      retellCallId: 'call_abc',
      status: 'COMPLETED',
      outcome: 'APPOINTMENT_BOOKED',
    });
  });
});
