import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallOutcome, CallStatus } from '@prisma/client';
import { parseEnv } from '../src/config/env.js';
import type { CallerStatusClient } from '../src/integrations/guidedBoost/callerStatus.client.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  findByLeadId: vi.fn(),
  markStatusReportPending: vi.fn(),
  markStatusReportSent: vi.fn(),
  markStatusReportFailed: vi.fn(),
}));

vi.mock('../src/repositories/callRecord.repository.js', () => ({
  getLatestCallRecordByLead: vi.fn(),
}));

vi.mock('../src/repositories/appointmentRecord.repository.js', () => ({
  findLatestAppointmentForLead: vi.fn(),
}));

const { mapToGuidedBoostStatus, enqueueQueueFinalization, deliverQueueFinalStatus, buildFinalStatusRequest } =
  await import('../src/services/guidedBoostStatus.service.js');
const { findByLeadId, markStatusReportPending, markStatusReportSent, markStatusReportFailed } =
  await import('../src/repositories/leadProcessing.repository.js');
const { getLatestCallRecordByLead } = await import('../src/repositories/callRecord.repository.js');
const { findLatestAppointmentForLead } = await import(
  '../src/repositories/appointmentRecord.repository.js'
);

function config(over: Record<string, string> = {}) {
  return parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', LEAD_API_KEY_CALLER: 'k', ...over });
}

function fakeClient(outcome: 'sent' | 'conflict' | 'failed') {
  return {
    reportFinalStatus: vi
      .fn()
      .mockResolvedValue({ outcome, httpStatus: outcome === 'failed' ? 503 : 200 }),
  } as unknown as CallerStatusClient;
}

const STARTED = new Date('2026-11-15T09:05:00.000Z');
const ENDED = new Date('2026-11-15T09:07:00.000Z');

function record(over: Record<string, unknown> = {}) {
  return {
    id: 'call-1',
    leadId: 'lead-1',
    status: CallStatus.COMPLETED,
    outcome: CallOutcome.UNKNOWN,
    startedAt: STARTED,
    endedAt: ENDED,
    retellCallId: 'retell_abc',
    summary: null,
    transcript: null,
    recordingUrl: null,
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findLatestAppointmentForLead).mockResolvedValue(null);
  vi.mocked(markStatusReportPending).mockResolvedValue(true);
  vi.mocked(markStatusReportSent).mockResolvedValue();
  vi.mocked(markStatusReportFailed).mockResolvedValue();
});

// ---------------------------------------------------------------------------
describe('mapToGuidedBoostStatus — unchanged mapping (Step 6)', () => {
  const base = { callStatus: CallStatus.COMPLETED, outcome: CallOutcome.UNKNOWN, hasAppointment: false, startedAt: null };

  it('booking → booked; outcomes map; busy carries reason; completed → reached_no_booking; unknown → call_failed', () => {
    expect(mapToGuidedBoostStatus({ ...base, hasAppointment: true }).status).toBe('booked');
    expect(mapToGuidedBoostStatus({ ...base, outcome: CallOutcome.DO_NOT_CONTACT }).status).toBe('do_not_call');
    expect(mapToGuidedBoostStatus({ ...base, outcome: CallOutcome.WRONG_NUMBER }).status).toBe('wrong_number');
    expect(mapToGuidedBoostStatus({ ...base, outcome: CallOutcome.CALLBACK_REQUESTED }).status).toBe('callback_requested');
    expect(mapToGuidedBoostStatus({ ...base, outcome: CallOutcome.VOICEMAIL }).status).toBe('voicemail');
    expect(mapToGuidedBoostStatus({ ...base, callStatus: CallStatus.NO_ANSWER }).status).toBe('no_answer');
    expect(mapToGuidedBoostStatus({ ...base, callStatus: CallStatus.BUSY })).toEqual({ status: 'no_answer', reason: 'busy' });
    expect(mapToGuidedBoostStatus({ ...base, callStatus: CallStatus.FAILED }).status).toBe('call_failed');
    expect(mapToGuidedBoostStatus({ ...base, callStatus: CallStatus.CANCELED, startedAt: null }).status).toBe('not_attempted');
    expect(mapToGuidedBoostStatus({ ...base, callStatus: CallStatus.CANCELED, startedAt: new Date() }).status).toBe('call_failed');
    expect(mapToGuidedBoostStatus(base).status).toBe('reached_no_booking');
    expect(mapToGuidedBoostStatus({ ...base, callStatus: CallStatus.UNKNOWN })).toEqual({
      status: 'call_failed',
      reason: 'no final result from provider',
    });
  });
});

// ---------------------------------------------------------------------------
describe('buildFinalStatusRequest — artifacts only when present (never fabricated)', () => {
  it('includes every available artifact with the contract field names', () => {
    const req = buildFinalStatusRequest(
      'reached_no_booking',
      null,
      record({ summary: 'Keen trekker', transcript: 'Agent: hi…', recordingUrl: 'https://rec/1' }),
    );
    expect(req).toEqual({
      status: 'reached_no_booking',
      summary: 'Keen trekker',
      transcript: 'Agent: hi…',
      recording_url: 'https://rec/1',
      call_id: 'retell_abc',
      started_at: STARTED.toISOString(),
      ended_at: ENDED.toISOString(),
    });
  });

  it('omits artifacts that are absent and includes the reason when present', () => {
    const req = buildFinalStatusRequest('no_answer', 'busy', record({
      status: CallStatus.BUSY,
      startedAt: null,
      endedAt: null,
      retellCallId: null,
    }));
    expect(req).toEqual({ status: 'no_answer', reason: 'busy' });
  });

  it('tolerates a missing CallRecord (status only)', () => {
    expect(buildFinalStatusRequest('call_failed', null, null)).toEqual({ status: 'call_failed' });
  });
});

// ---------------------------------------------------------------------------
describe('enqueueQueueFinalization — durable intent, no send', () => {
  it('POLL lead → no-op', async () => {
    vi.mocked(findByLeadId).mockResolvedValue({ leadId: 'lead-1', source: 'POLL' } as never);
    const r = await enqueueQueueFinalization(record(), { config: config() });
    expect(r).toEqual({ enqueued: false, skipped: 'not_queue' });
    expect(markStatusReportPending).not.toHaveBeenCalled();
  });

  it('already finalizing (status not null) → no-op (duplicate terminal webhook safe)', async () => {
    vi.mocked(findByLeadId).mockResolvedValue({ leadId: 'lead-1', source: 'QUEUE', statusReportStatus: 'pending' } as never);
    const r = await enqueueQueueFinalization(record(), { config: config() });
    expect(r).toEqual({ enqueued: false, skipped: 'already_finalizing' });
    expect(markStatusReportPending).not.toHaveBeenCalled();
  });

  it('COMPLETED QUEUE call → arms pending with the artifact-wait window', async () => {
    vi.mocked(findByLeadId).mockResolvedValue({ leadId: 'lead-1', source: 'QUEUE', statusReportStatus: null } as never);
    const now = new Date('2026-11-15T09:07:00.000Z');
    const r = await enqueueQueueFinalization(record(), { config: config(), now: () => now });

    expect(r).toMatchObject({ enqueued: true, status: 'reached_no_booking' });
    const call = vi.mocked(markStatusReportPending).mock.calls[0]!;
    expect(call[0]).toBe('lead-1');
    expect(call[1]).toBe('reached_no_booking');
    // default CALLER_FINALIZE_WAIT_MS = 120000
    expect((call[3]).getTime()).toBe(now.getTime() + 120_000);
  });

  it('non-COMPLETED terminal → zero wait (finalized next sweep)', async () => {
    vi.mocked(findByLeadId).mockResolvedValue({ leadId: 'lead-1', source: 'QUEUE', statusReportStatus: null } as never);
    const now = new Date('2026-11-15T09:07:00.000Z');
    const r = await enqueueQueueFinalization(record({ status: CallStatus.NO_ANSWER, outcome: CallOutcome.NOT_REACHED }), {
      config: config(),
      now: () => now,
    });
    expect(r).toMatchObject({ enqueued: true, status: 'no_answer' });
    const call = vi.mocked(markStatusReportPending).mock.calls[0]!;
    expect((call[3]).getTime()).toBe(now.getTime()); // waitMs = 0
  });

  it('booked when an appointment exists', async () => {
    vi.mocked(findByLeadId).mockResolvedValue({ leadId: 'lead-1', source: 'QUEUE', statusReportStatus: null } as never);
    vi.mocked(findLatestAppointmentForLead).mockResolvedValue({ id: 'appt-1' } as never);
    await enqueueQueueFinalization(record(), { config: config() });
    expect(vi.mocked(markStatusReportPending).mock.calls[0]![1]).toBe('booked');
  });
});

// ---------------------------------------------------------------------------
describe('deliverQueueFinalStatus — shared send (finalization + retry)', () => {
  it('sends the persisted status WITH current artifacts and marks sent', async () => {
    vi.mocked(getLatestCallRecordByLead).mockResolvedValue(
      record({ summary: 'S', transcript: 'T', recordingUrl: 'https://r/1' }),
    );
    const client = fakeClient('sent');

    const r = await deliverQueueFinalStatus('lead-1', 'reached_no_booking', null, {
      config: config(),
      statusClient: client,
    });

    expect(r.outcome).toBe('sent');
    expect(client.reportFinalStatus).toHaveBeenCalledWith('lead-1', {
      status: 'reached_no_booking',
      summary: 'S',
      transcript: 'T',
      recording_url: 'https://r/1',
      call_id: 'retell_abc',
      started_at: STARTED.toISOString(),
      ended_at: ENDED.toISOString(),
    });
    expect(markStatusReportSent).toHaveBeenCalledWith('lead-1', 'reached_no_booking', expect.any(Date));
  });

  it('does not re-derive: uses the PERSISTED status even if the record outcome differs', async () => {
    vi.mocked(getLatestCallRecordByLead).mockResolvedValue(record({ outcome: CallOutcome.VOICEMAIL }));
    const client = fakeClient('sent');
    await deliverQueueFinalStatus('lead-1', 'reached_no_booking', null, { config: config(), statusClient: client });
    expect((client.reportFinalStatus as ReturnType<typeof vi.fn>).mock.calls[0]![1].status).toBe('reached_no_booking');
  });

  it('409 → marks sent (resolved; first final wins)', async () => {
    vi.mocked(getLatestCallRecordByLead).mockResolvedValue(record());
    const r = await deliverQueueFinalStatus('lead-1', 'booked', null, { config: config(), statusClient: fakeClient('conflict') });
    expect(r.outcome).toBe('conflict');
    expect(markStatusReportSent).toHaveBeenCalledTimes(1);
    expect(markStatusReportFailed).not.toHaveBeenCalled();
  });

  it('failure → marks failed (retryable), preserving artifacts for the retry', async () => {
    vi.mocked(getLatestCallRecordByLead).mockResolvedValue(record());
    const r = await deliverQueueFinalStatus('lead-1', 'no_answer', 'busy', { config: config(), statusClient: fakeClient('failed') });
    expect(r.outcome).toBe('failed');
    expect(markStatusReportFailed).toHaveBeenCalledWith('lead-1', 'no_answer', expect.any(String), expect.any(Date));
    expect(markStatusReportSent).not.toHaveBeenCalled();
  });

  it('an unrecognized persisted status is never sent (marked failed)', async () => {
    const client = fakeClient('sent');
    const r = await deliverQueueFinalStatus('lead-1', 'bogus', null, { config: config(), statusClient: client });
    expect(r.outcome).toBe('invalid');
    expect(client.reportFinalStatus).not.toHaveBeenCalled();
    expect(markStatusReportFailed).toHaveBeenCalledTimes(1);
  });
});
