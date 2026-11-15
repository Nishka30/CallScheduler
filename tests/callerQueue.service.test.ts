import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessingStatus } from '@prisma/client';
import { parseEnv } from '../src/config/env.js';
import type { QueueLead } from '../src/integrations/guidedBoost/callerQueue.schemas.js';
import type { CallerQueueClient } from '../src/integrations/guidedBoost/callerQueue.client.js';

/**
 * Behaviour-level tests for queue ingestion (Step 3): technical safety, idempotent
 * duplicate protection, and the deliberate stop BEFORE dialling. Retell is never
 * constructed on this path, so "never calls Retell" is proven structurally.
 */

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  findByLeadId: vi.fn(),
  ingestQueueLeadProcessing: vi.fn(),
  claimEligibleLead: vi.fn(),
  markCalling: vi.fn(),
  sanitizeErrorMessage: (e: unknown) => String(e),
}));

vi.mock('../src/repositories/callRecord.repository.js', () => ({
  recordCallAttempt: vi.fn(),
}));

// Mock the orchestrator so the queue dial path reaches `placeCall` without a real
// Retell call, and so we can prove `initiateCallForLead` (the poll path, which
// carries the crm_route gate) is NEVER invoked by the queue path.
vi.mock('../src/services/callOrchestrator.service.js', () => ({
  placeCall: vi.fn(),
  initiateCallForLead: vi.fn(),
}));

// Keep the real LifecycleEvent/LifecycleStatus; stub only the DB-writing recorder.
vi.mock('../src/services/leadLifecycle.service.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, recordLifecycle: vi.fn().mockResolvedValue(true) };
});

const { ingestQueueLead, runCallerQueuePoll, dialPreparedQueueLead, buildQueueCallContext } =
  await import('../src/services/callerQueue.service.js');
const { findByLeadId, ingestQueueLeadProcessing, claimEligibleLead, markCalling } = await import(
  '../src/repositories/leadProcessing.repository.js'
);
const { recordCallAttempt } = await import('../src/repositories/callRecord.repository.js');
const { placeCall, initiateCallForLead } = await import('../src/services/callOrchestrator.service.js');
const { buildAgentDynamicVariables } = await import(
  '../src/integrations/retell/dynamicVariables.js'
);

function config(overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    RETELL_CALLING_ENABLED: 'true',
    ...overrides,
  });
}

const OFFERED_AT = new Date('2026-11-15T09:00:00.000Z');
const CALL_BEFORE = new Date('2026-11-15T09:10:00.000Z');

function queueLead(overrides: Partial<QueueLead> = {}): QueueLead {
  return {
    leadId: 'lead-1',
    phone: '+447700900123',
    name: 'John Smyth',
    brand: 'himalayan',
    answers: [],
    offeredAt: OFFERED_AT,
    callBeforeAt: CALL_BEFORE,
    isTest: false,
    ...overrides,
  };
}

const deps = () => ({ config: config(), now: () => new Date('2026-11-15T09:00:30.000Z') });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findByLeadId).mockResolvedValue(null);
  vi.mocked(ingestQueueLeadProcessing).mockResolvedValue({
    record: { id: 'proc-1', leadId: 'lead-1', status: ProcessingStatus.ELIGIBLE },
    created: true,
  } as never);
  // Happy-path dial defaults.
  vi.mocked(claimEligibleLead).mockResolvedValue({ id: 'proc-1', version: 1 } as never);
  vi.mocked(markCalling).mockResolvedValue({ id: 'proc-1', version: 2 } as never);
  vi.mocked(recordCallAttempt).mockResolvedValue({
    created: true,
    record: { id: 'call-1' },
  } as never);
  vi.mocked(placeCall).mockResolvedValue({
    outcome: 'call_initiated',
    leadId: 'lead-1',
    callRecordId: 'call-1',
    retellCallId: 'retell_abc',
  } as never);
});

describe('ingestQueueLead — technical safety', () => {
  it('master switch off: does not ingest and does not prepare a call', async () => {
    const result = await ingestQueueLead(queueLead(), {
      config: config({ RETELL_CALLING_ENABLED: 'false' }),
    });

    expect(result.outcome).toBe('calling_disabled');
    expect(findByLeadId).not.toHaveBeenCalled();
    expect(ingestQueueLeadProcessing).not.toHaveBeenCalled();
  });

  it('valid phone: ingests ELIGIBLE (QUEUE) and reaches the prepared boundary', async () => {
    const result = await ingestQueueLead(queueLead(), deps());

    expect(result.outcome).toBe('prepared');
    expect(result.phoneE164).toBe('+447700900123');
    expect(result.queueLead?.leadId).toBe('lead-1');
    expect(ingestQueueLeadProcessing).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-1', status: ProcessingStatus.ELIGIBLE }),
    );
  });

  it('invalid phone: records SKIPPED/phone_not_validated and never prepares a call', async () => {
    const result = await ingestQueueLead(queueLead({ phone: '07700900123' }), deps());

    expect(result.outcome).toBe('rejected_phone');
    expect(result.phoneE164).toBeUndefined();
    expect(ingestQueueLeadProcessing).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ProcessingStatus.SKIPPED,
        decisionReason: 'phone_not_validated',
      }),
    );
  });

  it('stores call_before as the authoritative absolute deadline', async () => {
    await ingestQueueLead(queueLead(), deps());

    expect(ingestQueueLeadProcessing).toHaveBeenCalledWith(
      expect.objectContaining({ callBeforeAt: CALL_BEFORE, offeredAt: OFFERED_AT }),
    );
  });

  it('does not apply a crm_route / business gate to a QUEUE lead', async () => {
    // A pre-qualified queue lead has no crm_route in its payload; ingestion must
    // succeed on technical safety alone (no business-eligibility rejection).
    const result = await ingestQueueLead(queueLead(), deps());
    expect(result.outcome).toBe('prepared');
  });
});

describe('ingestQueueLead — idempotent duplicate protection', () => {
  it('an existing processing row (any source) prevents a duplicate candidate', async () => {
    vi.mocked(findByLeadId).mockResolvedValue({
      id: 'proc-1',
      leadId: 'lead-1',
      status: ProcessingStatus.CALLING,
      source: 'QUEUE',
    } as never);

    const result = await ingestQueueLead(queueLead(), deps());

    expect(result.outcome).toBe('duplicate');
    expect(ingestQueueLeadProcessing).not.toHaveBeenCalled();
  });

  it('an existing POLL row is left untouched (treated as duplicate)', async () => {
    vi.mocked(findByLeadId).mockResolvedValue({
      id: 'proc-poll',
      leadId: 'lead-1',
      status: ProcessingStatus.ELIGIBLE,
      source: 'POLL',
    } as never);

    const result = await ingestQueueLead(queueLead(), deps());

    expect(result.outcome).toBe('duplicate');
    expect(ingestQueueLeadProcessing).not.toHaveBeenCalled();
  });

  // Scenario 3: a QUEUE lead whose single attempt already finished. A repeated
  // offer (before the Step-4 final-status report makes GB stop offering) must not
  // re-open it or dial again — the terminal state has no re-open transition.
  it.each([
    ProcessingStatus.COMPLETED,
    ProcessingStatus.FAILED,
    ProcessingStatus.SKIPPED,
  ])('a terminal QUEUE row (%s) is never re-opened or re-attempted', async (status) => {
    vi.mocked(findByLeadId).mockResolvedValue({
      id: 'proc-1',
      leadId: 'lead-1',
      status,
      source: 'QUEUE',
    } as never);

    const result = await ingestQueueLead(queueLead(), deps());

    expect(result.outcome).toBe('duplicate');
    expect(ingestQueueLeadProcessing).not.toHaveBeenCalled();
  });

  // Scenario 4: a POLL call in flight/claimed must block the queue offer.
  it.each([ProcessingStatus.PROCESSING, ProcessingStatus.CALLING])(
    'an active POLL row (%s) blocks the queue offer (one-call guarantee)',
    async (status) => {
      vi.mocked(findByLeadId).mockResolvedValue({
        id: 'proc-poll',
        leadId: 'lead-1',
        status,
        source: 'POLL',
      } as never);

      const result = await ingestQueueLead(queueLead(), deps());

      expect(result.outcome).toBe('duplicate');
      expect(ingestQueueLeadProcessing).not.toHaveBeenCalled();
    },
  );

  // Scenario 5: a terminal POLL decision is not re-opened by a queue offer (no
  // terminal -> active transition exists; a COMPLETED poll lead was already called).
  it.each([
    ProcessingStatus.COMPLETED,
    ProcessingStatus.FAILED,
    ProcessingStatus.SKIPPED,
    ProcessingStatus.RETRY_PENDING,
  ])('a terminal/retry POLL row (%s) blocks the queue offer', async (status) => {
    vi.mocked(findByLeadId).mockResolvedValue({
      id: 'proc-poll',
      leadId: 'lead-1',
      status,
      source: 'POLL',
    } as never);

    const result = await ingestQueueLead(queueLead(), deps());

    expect(result.outcome).toBe('duplicate');
    expect(ingestQueueLeadProcessing).not.toHaveBeenCalled();
  });

  it('a race where the row already exists at insert yields duplicate (created=false)', async () => {
    vi.mocked(ingestQueueLeadProcessing).mockResolvedValue({
      record: { id: 'proc-1', leadId: 'lead-1', status: ProcessingStatus.ELIGIBLE },
      created: false,
    } as never);

    const result = await ingestQueueLead(queueLead(), deps());
    expect(result.outcome).toBe('duplicate');
  });
});

describe('runCallerQueuePoll', () => {
  function fakeClient(lead: QueueLead | null) {
    return { fetchQueue: vi.fn().mockResolvedValue(lead) } as unknown as CallerQueueClient;
  }

  it('master switch off: does not even fetch the queue', async () => {
    const client = fakeClient(queueLead());
    const summary = await runCallerQueuePoll({
      config: config({ RETELL_CALLING_ENABLED: 'false' }),
      queueClient: client,
    });

    expect(summary).toMatchObject({ enabled: false, fetched: false });
    expect(client.fetchQueue).not.toHaveBeenCalled();
  });

  it('empty queue: fetches, ingests nothing', async () => {
    const summary = await runCallerQueuePoll({ ...deps(), queueClient: fakeClient(null) });
    expect(summary).toMatchObject({ enabled: true, fetched: false });
    expect(ingestQueueLeadProcessing).not.toHaveBeenCalled();
  });

  it('one offered lead: fetches and ingests it (prepared)', async () => {
    const summary = await runCallerQueuePoll({ ...deps(), queueClient: fakeClient(queueLead()) });
    expect(summary).toMatchObject({ enabled: true, fetched: true, outcome: 'prepared' });
  });

  it('repeated polling of the same item does not create a second candidate', async () => {
    const client = fakeClient(queueLead());
    const d = { ...deps(), queueClient: client };

    // First poll ingests (created=true). Second poll: the row now exists.
    await runCallerQueuePoll(d);
    vi.mocked(findByLeadId).mockResolvedValue({
      id: 'proc-1',
      leadId: 'lead-1',
      status: ProcessingStatus.CALLING,
      source: 'QUEUE',
    } as never);
    const second = await runCallerQueuePoll(d);

    expect(second.outcome).toBe('duplicate');
    // Ingest-create attempted only on the first poll, never a second time.
    expect(ingestQueueLeadProcessing).toHaveBeenCalledTimes(1);
    // And the second poll never opened a second CallRecord.
    expect(recordCallAttempt).toHaveBeenCalledTimes(1);
  });
});

describe('dialPreparedQueueLead — reaches placeCall safely', () => {
  const prepared = () => ({
    leadId: 'lead-1',
    queueLead: queueLead(),
    phoneE164: '+447700900123',
  });

  it('claims, opens a CallRecord, and invokes placeCall with the validated E.164', async () => {
    const result = await dialPreparedQueueLead(prepared(), deps());

    expect(result.outcome).toBe('call_initiated');
    expect(claimEligibleLead).toHaveBeenCalledTimes(1);
    expect(markCalling).toHaveBeenCalledWith('proc-1', 1, expect.any(Date));
    expect(recordCallAttempt).toHaveBeenCalledWith({ leadId: 'lead-1' });
    expect(placeCall).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(placeCall).mock.calls[0]![0];
    expect(arg.toNumber).toBe('+447700900123');
    expect(arg.callRecordId).toBe('call-1');
    expect(arg.processingId).toBe('proc-1');
    expect(arg.processingVersion).toBe(2);
  });

  it('NEVER calls initiateCallForLead (so the poll crm_route gate cannot apply)', async () => {
    await dialPreparedQueueLead(prepared(), deps());
    expect(initiateCallForLead).not.toHaveBeenCalled();
  });

  it('a lost claim race (claimEligibleLead null) prevents the call', async () => {
    vi.mocked(claimEligibleLead).mockResolvedValue(null);

    const result = await dialPreparedQueueLead(prepared(), deps());

    expect(result.outcome).toBe('claim_failed');
    expect(placeCall).not.toHaveBeenCalled();
  });

  it('a failed PROCESSING -> CALLING transition prevents the call', async () => {
    vi.mocked(markCalling).mockResolvedValue(null);

    const result = await dialPreparedQueueLead(prepared(), deps());

    expect(result.outcome).toBe('claim_failed');
    expect(recordCallAttempt).not.toHaveBeenCalled();
    expect(placeCall).not.toHaveBeenCalled();
  });

  it('an existing active attempt does not open a second CallRecord or dial', async () => {
    vi.mocked(recordCallAttempt).mockResolvedValue({
      created: false,
      record: { id: 'existing-call' },
    } as never);

    const result = await dialPreparedQueueLead(prepared(), deps());

    expect(result).toMatchObject({ outcome: 'duplicate_attempt', callRecordId: 'existing-call' });
    expect(placeCall).not.toHaveBeenCalled();
  });

  it('passes the built call context (customer_name/brand) to placeCall', async () => {
    await dialPreparedQueueLead(prepared(), deps());
    const arg = vi.mocked(placeCall).mock.calls[0]![0];
    const vars = buildAgentDynamicVariables(arg.context);
    expect(vars.customer_name).toBe('John Smyth');
    expect(vars.brand_name).toBe('himalayan');
  });
});

describe('runCallerQueuePoll — end to end reaches placeCall', () => {
  function fakeClient(lead: QueueLead | null) {
    return { fetchQueue: vi.fn().mockResolvedValue(lead) } as unknown as CallerQueueClient;
  }

  it('a prepared lead is dialled via placeCall in the same cycle', async () => {
    const summary = await runCallerQueuePoll({ ...deps(), queueClient: fakeClient(queueLead()) });
    expect(summary).toMatchObject({ outcome: 'prepared', callOutcome: 'call_initiated' });
    expect(placeCall).toHaveBeenCalledTimes(1);
  });

  it('master switch off: never reaches placeCall', async () => {
    await runCallerQueuePoll({
      config: config({ RETELL_CALLING_ENABLED: 'false' }),
      queueClient: fakeClient(queueLead()),
    });
    expect(placeCall).not.toHaveBeenCalled();
  });

  it('invalid phone: never reaches placeCall', async () => {
    const summary = await runCallerQueuePoll({
      ...deps(),
      queueClient: fakeClient(queueLead({ phone: '07700900123' })),
    });
    expect(summary.outcome).toBe('rejected_phone');
    expect(placeCall).not.toHaveBeenCalled();
  });
});

describe('buildQueueCallContext — maps the payload into existing agent variables', () => {
  it('produces the confirmed Travel Call Agent dynamic variables (dynamic page, no Nepal)', () => {
    const context = buildQueueCallContext(
      queueLead({
        name: 'Jane Doe',
        brand: 'himalayan',
        pageSlug: 'everest-base-camp',
        timeZone: 'Europe/London',
        answers: [
          { questionId: 'confirm_trek', prompt: 'Which trek?', answer: 'EBC' },
          { questionId: 'timing', prompt: 'When?', answer: 'April' },
        ],
      }),
    );
    const vars = buildAgentDynamicVariables(context);

    expect(vars.customer_name).toBe('Jane Doe');
    expect(vars.brand_name).toBe('himalayan');
    expect(vars.enquired_destination).toBe('Everest Base Camp');
    expect(vars.preferred_trek).toBe('EBC');
    expect(vars.travel_timing).toBe('April');
    expect(vars.customer_timezone).toBe('Europe/London');
  });

  it('omits variables for absent fields (nothing invented)', () => {
    // A lead carrying only the required fields — no name/brand/page_slug/answers.
    const minimal: QueueLead = {
      leadId: 'lead-1',
      phone: '+447700900123',
      answers: [],
      offeredAt: OFFERED_AT,
      callBeforeAt: CALL_BEFORE,
      isTest: false,
    };
    const vars = buildAgentDynamicVariables(buildQueueCallContext(minimal));
    expect(vars.customer_name).toBeUndefined();
    expect(vars.brand_name).toBeUndefined();
    expect(vars.enquired_destination).toBeUndefined();
    expect(vars.preferred_trek).toBeUndefined();
  });
});
