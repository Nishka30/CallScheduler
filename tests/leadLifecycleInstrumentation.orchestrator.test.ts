import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { RetellApiError } from '../src/integrations/retell/errors.js';
import type { LeadApiClient } from '../src/integrations/leadApi/client.js';
import type { RetellClient } from '../src/integrations/retell/client.js';

// Lifecycle instrumentation for the call orchestrator. Mirrors the mock harness
// of callOrchestrator.test.ts, and PARTIALLY mocks the lifecycle service so only
// `recordLifecycle` is a spy (the event constants/helpers stay real).

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  claimEligibleLead: vi.fn(),
  markCalling: vi.fn(),
  completeProcessing: vi.fn(),
  finalizeRejectedEligibleLead: vi.fn(),
  finalizeHoldExpired: vi.fn(),
  findByLeadId: vi.fn(),
}));

vi.mock('../src/repositories/callRecord.repository.js', () => ({
  recordCallAttempt: vi.fn(),
  attachProviderCallId: vi.fn(),
  markCallAttemptFailed: vi.fn(),
  getLatestCallRecordByLead: vi.fn(),
}));

vi.mock('../src/services/callNoteDelivery.service.js', () => ({
  deliverCallNote: vi.fn().mockResolvedValue('sent'),
}));

vi.mock('../src/services/reviewNoteDelivery.service.js', () => ({
  enqueueReviewNote: vi.fn().mockResolvedValue(true),
}));

const recordLifecycle = vi.fn().mockResolvedValue(true);
vi.mock('../src/services/leadLifecycle.service.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, recordLifecycle: (...a: unknown[]) => recordLifecycle(...a) };
});

const { initiateCallForLead } = await import('../src/services/callOrchestrator.service.js');
const { claimEligibleLead, markCalling, completeProcessing, finalizeRejectedEligibleLead, finalizeHoldExpired } =
  await import('../src/repositories/leadProcessing.repository.js');
const { recordCallAttempt, attachProviderCallId, markCallAttemptFailed } =
  await import('../src/repositories/callRecord.repository.js');

const NOW = new Date('2026-10-16T12:00:00.000Z');
const FUTURE_HOLD = '2026-10-16T12:05:00.000Z';

function config(overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    RETELL_CALLING_ENABLED: 'true',
    RETELL_API_KEY: 'k',
    RETELL_FROM_NUMBER: '+19789538571',
    RETELL_AGENT_ID: 'agent_1',
    ...overrides,
  });
}

function detail(currentOverrides: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  return {
    current: {
      is_lead: true,
      is_deleted: false,
      lead_status: 'New Lead',
      created_at: '2026-10-16T11:50:00.000Z',
      updated_at: '2026-10-16T11:55:00.000Z',
      caller_hold_until: FUTURE_HOLD,
      person_key: 'lead:1',
      phone: '+447700900123',
      crm_route: null,
      booked_call: null,
      sales_agent_email: null,
      ...currentOverrides,
    },
    captured: {},
    personKey: 'lead:1',
    phone: { phone_e164: '+447700900123', valid: true, tier: 'live_mobile', line_type: 'mobile', lookup_status: 'ok' },
    answers: [],
    ...rest,
  };
}

function fakeClients(detailValue: unknown = detail(), retellResult: unknown = { callId: 'retell_abc' }) {
  const getLead = vi.fn().mockResolvedValue(detailValue);
  const getPerson = vi.fn().mockResolvedValue({ profile: {}, leads: [] });
  const createPhoneCall =
    retellResult instanceof Error ? vi.fn().mockRejectedValue(retellResult) : vi.fn().mockResolvedValue(retellResult);
  return {
    leadApiClient: { getLead, getPerson } as unknown as LeadApiClient,
    retellClient: { createPhoneCall } as unknown as RetellClient,
    config: config(),
    now: () => NOW,
    workerId: 'test-worker',
  };
}

function logged() {
  return recordLifecycle.mock.calls.map((c) => c[0] as Record<string, unknown>);
}
function find(event: string) {
  return logged().find((e) => e['event'] === event);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordLifecycle.mockResolvedValue(true);
  vi.mocked(claimEligibleLead).mockResolvedValue({ id: 'proc-1', version: 1 } as never);
  vi.mocked(markCalling).mockResolvedValue({ id: 'proc-1', version: 2 } as never);
  vi.mocked(completeProcessing).mockResolvedValue(true);
  vi.mocked(recordCallAttempt).mockResolvedValue({ created: true, record: { id: 'call-1' } } as never);
  vi.mocked(attachProviderCallId).mockResolvedValue({ id: 'call-1' } as never);
  vi.mocked(markCallAttemptFailed).mockResolvedValue({ id: 'call-1', leadId: 'lead-1' } as never);
  vi.mocked(finalizeRejectedEligibleLead).mockResolvedValue(true);
  vi.mocked(finalizeHoldExpired).mockResolvedValue('skipped');
});

describe('orchestrator lifecycle instrumentation — happy path', () => {
  it('records each passing stage through to the Retell call id', async () => {
    const result = await initiateCallForLead('lead-1', fakeClients());
    expect(result.outcome).toBe('call_initiated');

    expect(find('eligibility_checked')).toMatchObject({ status: 'passed' });
    expect(find('phone_checked')).toMatchObject({ status: 'passed' });
    expect(find('crm_gate_checked')).toMatchObject({ status: 'passed' });
    expect(find('hold_checked')).toMatchObject({ status: 'active' });
    expect(find('call_attempt')).toMatchObject({ status: 'attempted' });

    const retell = find('retell_initiated');
    expect(retell).toMatchObject({ event: 'retell_initiated' });
    expect((retell!['metadata'] as Record<string, unknown>)['retellCallId']).toBe('retell_abc');
  });
});

describe('orchestrator lifecycle instrumentation — rejections', () => {
  it('records a CRM-gate rejection with the real reason', async () => {
    const result = await initiateCallForLead('lead-1', fakeClients(detail({ crm_route: 'legacy' })));
    expect(result).toMatchObject({ outcome: 'rejected_eligibility', reason: 'crm_route_excluded' });

    expect(find('eligibility_checked')).toMatchObject({ status: 'passed' });
    const gate = find('crm_gate_checked');
    expect(gate).toMatchObject({ status: 'rejected', reason: 'crm_route_excluded' });
    expect((gate!['metadata'] as Record<string, unknown>)['crmRoute']).toBe('legacy');
    // never reached the call stage
    expect(find('call_attempt')).toBeUndefined();
  });

  it('records an eligibility rejection for a deleted lead', async () => {
    await initiateCallForLead('lead-1', fakeClients(detail({ is_deleted: true })));
    expect(find('eligibility_checked')).toMatchObject({ status: 'rejected', reason: 'lead_deleted' });
  });

  it('records a call failure when the provider refuses before dialling', async () => {
    const err = new RetellApiError('auth', 'bad key', { path: '/create-phone-call', status: 401 });
    const result = await initiateCallForLead('lead-1', fakeClients(detail(), err));
    expect(result.outcome).toBe('provider_failed');

    const failed = find('call_failed');
    expect(failed).toMatchObject({ event: 'call_failed', status: 'FAILED' });
  });
});

describe('orchestrator lifecycle instrumentation — previously-invisible exits', () => {
  it('records a calling_disabled event when the master switch is off', async () => {
    const deps = fakeClients();
    deps.config = config({ RETELL_CALLING_ENABLED: 'false' });

    const result = await initiateCallForLead('lead-1', deps);

    expect(result.outcome).toBe('calling_disabled');
    expect(find('calling_disabled')).toMatchObject({
      event: 'calling_disabled',
      status: 'rejected',
      reason: 'calling_disabled',
    });
  });

  it('records a lead_unavailable event when the lead detail fetch fails', async () => {
    const deps = fakeClients();
    deps.leadApiClient.getLead = vi.fn().mockRejectedValue(new Error('lead api down'));

    const result = await initiateCallForLead('lead-1', deps);

    expect(result.outcome).toBe('lead_unavailable');
    expect(find('lead_unavailable')).toMatchObject({
      event: 'lead_unavailable',
      status: 'rejected',
      reason: 'lead_unavailable',
    });
    // never reached the orchestrator's later stages
    expect(find('eligibility_checked')).toBeUndefined();
    expect(find('call_attempt')).toBeUndefined();
  });

  it('the happy path records none of the new blind-spot events', async () => {
    const result = await initiateCallForLead('lead-1', fakeClients());
    expect(result.outcome).toBe('call_initiated');
    expect(find('calling_disabled')).toBeUndefined();
    expect(find('lead_unavailable')).toBeUndefined();
  });
});
