import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { RetellApiError } from '../src/integrations/retell/errors.js';
import { LeadApiError } from '../src/integrations/leadApi/errors.js';
import type { LeadApiClient } from '../src/integrations/leadApi/client.js';
import type { RetellClient } from '../src/integrations/retell/client.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  claimEligibleLead: vi.fn(),
  markCalling: vi.fn(),
  completeProcessing: vi.fn(),
}));

vi.mock('../src/repositories/callRecord.repository.js', () => ({
  recordCallAttempt: vi.fn(),
  attachProviderCallId: vi.fn(),
}));

const { initiateCallForLead } = await import('../src/services/callOrchestrator.service.js');
const { claimEligibleLead, markCalling, completeProcessing } =
  await import('../src/repositories/leadProcessing.repository.js');
const { recordCallAttempt, attachProviderCallId } =
  await import('../src/repositories/callRecord.repository.js');

const NOW = new Date('2026-10-16T12:00:00.000Z');
const FUTURE_HOLD = '2026-10-16T12:05:00.000Z';
const EXPIRED_HOLD = '2026-10-16T11:55:00.000Z';

function config(overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    RETELL_CALLING_ENABLED: 'true', // injected config only; never the global/.env switch
    RETELL_API_KEY: 'k',
    RETELL_FROM_NUMBER: '+19789538571',
    RETELL_AGENT_ID: 'agent_1',
    ...overrides,
  });
}

function detail(
  currentOverrides: Record<string, unknown> = {},
  rest: Record<string, unknown> = {},
) {
  return {
    current: {
      is_lead: true,
      is_deleted: false,
      lead_status: 'New Lead',
      created_at: '2026-10-16T11:50:00.000Z',
      updated_at: '2026-10-16T11:55:00.000Z',
      caller_hold_until: FUTURE_HOLD,
      person_key: 'lead:1',
      // Oct 20 routing/ownership fields — callable defaults.
      phone: '+447700900123',
      crm_route: null,
      booked_call: null,
      sales_agent_email: null,
      ...currentOverrides,
    },
    captured: {},
    personKey: 'lead:1',
    phone: {
      phone_e164: '+447700900123',
      valid: true,
      tier: 'live_mobile',
      line_type: 'mobile',
      lookup_status: 'ok',
    },
    answers: [],
    ...rest,
  };
}

function fakeClients(
  detailValue: unknown = detail(),
  retellResult: unknown = { callId: 'retell_abc' },
) {
  const getLead = vi.fn().mockResolvedValue(detailValue);
  const getPerson = vi.fn().mockResolvedValue({ profile: {}, leads: [] });
  const createPhoneCall =
    retellResult instanceof Error
      ? vi.fn().mockRejectedValue(retellResult)
      : vi.fn().mockResolvedValue(retellResult);
  return {
    leadApiClient: { getLead, getPerson } as unknown as LeadApiClient,
    retellClient: { createPhoneCall } as unknown as RetellClient,
    config: config(),
    now: () => NOW,
    workerId: 'test-worker',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Happy-path defaults; individual tests override.
  vi.mocked(claimEligibleLead).mockResolvedValue({ id: 'proc-1', version: 1 } as never);
  vi.mocked(markCalling).mockResolvedValue({ id: 'proc-1', version: 2 } as never);
  vi.mocked(completeProcessing).mockResolvedValue(true);
  vi.mocked(recordCallAttempt).mockResolvedValue({
    created: true,
    record: { id: 'call-1' },
  } as never);
  vi.mocked(attachProviderCallId).mockResolvedValue({ id: 'call-1' } as never);
});

describe('initiateCallForLead — safety switch', () => {
  it('does nothing at all when calling is disabled', async () => {
    const deps = fakeClients();
    deps.config = config({ RETELL_CALLING_ENABLED: 'false' });

    const result = await initiateCallForLead('lead-1', deps);

    expect(result.outcome).toBe('calling_disabled');
    expect(deps.leadApiClient.getLead).not.toHaveBeenCalled();
    expect(claimEligibleLead).not.toHaveBeenCalled();
    expect(deps.retellClient.createPhoneCall).not.toHaveBeenCalled();
  });

  it('is disabled by default (no explicit override)', async () => {
    const deps = fakeClients();
    deps.config = parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });

    expect((await initiateCallForLead('lead-1', deps)).outcome).toBe('calling_disabled');
  });
});

describe('initiateCallForLead — read-only validation gates', () => {
  it('returns lead_unavailable when the Lead API detail fetch fails', async () => {
    const deps = fakeClients();
    deps.leadApiClient.getLead = vi
      .fn()
      .mockRejectedValue(new LeadApiError('server', 'down', { path: '/x', status: 503 }));

    const result = await initiateCallForLead('lead-1', deps);

    expect(result.outcome).toBe('lead_unavailable');
    expect(claimEligibleLead).not.toHaveBeenCalled();
  });

  it('rejects a deleted lead on eligibility', async () => {
    const deps = fakeClients(detail({ is_deleted: true }));
    const result = await initiateCallForLead('lead-1', deps);
    expect(result).toMatchObject({ outcome: 'rejected_eligibility', reason: 'lead_deleted' });
    expect(claimEligibleLead).not.toHaveBeenCalled();
  });

  it('rejects a non-lead record', async () => {
    const deps = fakeClients(detail({ is_lead: false }));
    expect((await initiateCallForLead('lead-1', deps)).outcome).toBe('rejected_eligibility');
  });

  it('rejects a blocked status', async () => {
    const deps = fakeClients(detail({ lead_status: 'Unsubscribe' }));
    const result = await initiateCallForLead('lead-1', deps);
    expect(result).toMatchObject({ outcome: 'rejected_eligibility', reason: 'status_blocked' });
  });

  it('rejects an unvalidated phone number', async () => {
    const deps = fakeClients(
      detail({}, { phone: { phone_e164: null, valid: null, tier: 'none' } }),
    );
    const result = await initiateCallForLead('lead-1', deps);
    expect(result.outcome).toBe('rejected_phone');
    expect(deps.retellClient.createPhoneCall).not.toHaveBeenCalled();
  });

  it('never dials phone_raw / an unvalidated number', async () => {
    const deps = fakeClients(
      detail(
        {},
        {
          phone: {
            phone_raw: '07700900123',
            phone_best: '+447700900123',
            phone_e164: null,
            valid: null,
          },
        },
      ),
    );
    const result = await initiateCallForLead('lead-1', deps);
    expect(result.outcome).toBe('rejected_phone');
    expect(claimEligibleLead).not.toHaveBeenCalled();
  });

  it('rejects when the caller hold has expired (never call late)', async () => {
    const deps = fakeClients(detail({ caller_hold_until: EXPIRED_HOLD }));
    const result = await initiateCallForLead('lead-1', deps);
    expect(result.outcome).toBe('rejected_hold_expired');
    expect(claimEligibleLead).not.toHaveBeenCalled();
  });

  it('rejects when there is no active hold (null)', async () => {
    const deps = fakeClients(detail({ caller_hold_until: null }));
    expect((await initiateCallForLead('lead-1', deps)).outcome).toBe('rejected_hold_expired');
  });
});

describe('initiateCallForLead — claim and duplicate guards', () => {
  it('returns claim_failed when the lead cannot be claimed (not ELIGIBLE / race)', async () => {
    vi.mocked(claimEligibleLead).mockResolvedValue(null);
    const deps = fakeClients();

    const result = await initiateCallForLead('lead-1', deps);

    expect(result.outcome).toBe('claim_failed');
    expect(deps.retellClient.createPhoneCall).not.toHaveBeenCalled();
  });

  it('returns claim_failed when PROCESSING -> CALLING does not apply', async () => {
    vi.mocked(markCalling).mockResolvedValue(null);
    const deps = fakeClients();

    const result = await initiateCallForLead('lead-1', deps);

    expect(result.outcome).toBe('claim_failed');
    expect(deps.retellClient.createPhoneCall).not.toHaveBeenCalled();
  });

  it('does not dial when an unresolved attempt already exists', async () => {
    vi.mocked(recordCallAttempt).mockResolvedValue({
      created: false,
      record: { id: 'existing-call' },
    } as never);
    const deps = fakeClients();

    const result = await initiateCallForLead('lead-1', deps);

    expect(result).toMatchObject({ outcome: 'duplicate_attempt', callRecordId: 'existing-call' });
    expect(deps.retellClient.createPhoneCall).not.toHaveBeenCalled();
  });
});

describe('initiateCallForLead — dialling', () => {
  it('records the attempt BEFORE invoking Retell', async () => {
    const order: string[] = [];
    vi.mocked(recordCallAttempt).mockImplementation(() => {
      order.push('recordAttempt');
      return Promise.resolve({ created: true, record: { id: 'call-1' } } as never);
    });
    const deps = fakeClients();
    deps.retellClient.createPhoneCall = vi.fn().mockImplementation(() => {
      order.push('createPhoneCall');
      return Promise.resolve({ callId: 'retell_abc' });
    });

    await initiateCallForLead('lead-1', deps);

    expect(order).toEqual(['recordAttempt', 'createPhoneCall']);
  });

  it('initiates the call and links the provider call id, using the validated E.164', async () => {
    const deps = fakeClients();

    const result = await initiateCallForLead('lead-1', deps);

    expect(result).toMatchObject({
      outcome: 'call_initiated',
      callRecordId: 'call-1',
      retellCallId: 'retell_abc',
    });
    const callArg = (deps.retellClient.createPhoneCall as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(callArg.toNumber).toBe('+447700900123');
    expect(callArg.idempotencyKey).toBe('call-1');
    expect(callArg.metadata).toEqual({ leadId: 'lead-1', callRecordId: 'call-1' });
    expect(attachProviderCallId).toHaveBeenCalledWith('call-1', 'retell_abc', expect.any(Date));
  });

  it('omits dynamic variables when the lead has no name or brand', async () => {
    const deps = fakeClients(); // base detail has no name/brand in current
    await initiateCallForLead('lead-1', deps);
    const callArg = (deps.retellClient.createPhoneCall as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(callArg.dynamicVariables).toBeUndefined();
  });

  it('passes customer_name and brand_name when present (the two confirmed agent vars)', async () => {
    const deps = fakeClients(detail({ name: 'John Smyth', brand: 'himalayan' }));
    await initiateCallForLead('lead-1', deps);
    const callArg = (deps.retellClient.createPhoneCall as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(callArg.dynamicVariables).toEqual({
      customer_name: 'John Smyth',
      brand_name: 'himalayan',
    });
  });

  it('treats a provider timeout as uncertain: no retry, not marked failed, left CALLING', async () => {
    const deps = fakeClients(
      detail(),
      new RetellApiError('network', 'timed out', { path: '/v2/create-phone-call' }),
    );

    const result = await initiateCallForLead('lead-1', deps);

    expect(result.outcome).toBe('provider_uncertain');
    expect(completeProcessing).not.toHaveBeenCalled(); // never finalised on uncertainty
    expect(deps.retellClient.createPhoneCall).toHaveBeenCalledTimes(1); // single-shot, no retry
  });

  it('treats a 5xx as uncertain too', async () => {
    const deps = fakeClients(
      detail(),
      new RetellApiError('server', 'boom', { path: '/x', status: 502 }),
    );
    const result = await initiateCallForLead('lead-1', deps);
    expect(result.outcome).toBe('provider_uncertain');
    expect(completeProcessing).not.toHaveBeenCalled();
  });

  it('marks FAILED on a permanent provider error (definitely not dialled)', async () => {
    const deps = fakeClients(
      detail(),
      new RetellApiError('auth', 'bad key', { path: '/x', status: 401 }),
    );

    const result = await initiateCallForLead('lead-1', deps);

    expect(result).toMatchObject({ outcome: 'provider_failed', reason: 'auth' });
    expect(completeProcessing).toHaveBeenCalledWith('proc-1', 2, 'FAILED', expect.anything());
  });
});

describe('initiateCallForLead — Oct 20 crm_route / ownership gate', () => {
  it('rejects a lead already routed to legacy', async () => {
    const deps = fakeClients(detail({ crm_route: 'legacy' }));
    const r = await initiateCallForLead('lead-1', deps);
    expect(r).toMatchObject({ outcome: 'rejected_eligibility', reason: 'crm_route_excluded' });
    expect(claimEligibleLead).not.toHaveBeenCalled();
  });

  it('rejects a lead whose call is already booked (crm_route=crm)', async () => {
    const deps = fakeClients(detail({ crm_route: 'crm' }));
    expect((await initiateCallForLead('lead-1', deps)).outcome).toBe('rejected_eligibility');
  });

  it('rejects a lead that already has a sales agent', async () => {
    const deps = fakeClients(detail({ sales_agent_email: 'sue@hw.com' }));
    const r = await initiateCallForLead('lead-1', deps);
    expect(r).toMatchObject({ outcome: 'rejected_eligibility', reason: 'already_assigned' });
  });

  it('rejects a lead that already has a booked_call', async () => {
    const deps = fakeClients(detail({ booked_call: 'appt_1' }));
    expect((await initiateCallForLead('lead-1', deps)).reason).toBe('already_booked');
  });
});
