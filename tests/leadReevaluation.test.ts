import { describe, expect, it, vi } from 'vitest';
import { ProcessingStatus } from '@prisma/client';
import type { LeadApiClient } from '../src/integrations/leadApi/client.js';
import type { LeadDetail, PersonHistory } from '../src/integrations/leadApi/schemas.js';
import type { OrchestratorResult } from '../src/services/callOrchestrator.service.js';
import { parseEnv } from '../src/config/env.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const findByLeadId = vi.fn();
const reevaluateNeedsReviewDecision = vi.fn();
vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  findByLeadId: (...args: unknown[]) => findByLeadId(...args),
  reevaluateNeedsReviewDecision: (...args: unknown[]) => reevaluateNeedsReviewDecision(...args),
}));

const { reevaluateNeedsReviewLead } = await import('../src/services/leadReevaluation.service.js');

function config(overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    LEAD_ELIGIBILITY_AUTO_ENABLED: 'true',
    RETELL_CALLING_ENABLED: 'false',
    ...overrides,
  });
}

function processingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proc-1',
    leadId: 'lead-1',
    status: ProcessingStatus.NEEDS_REVIEW,
    decisionReason: 'phone_verdict_unreadable',
    version: 2,
    ...overrides,
  };
}

const VALID_PHONE = {
  phone_raw: '+916291764011',
  phone_e164: '+916291764011',
  phone_best: '+916291764011',
  valid: true,
  tier: 'live_mobile',
  line_type: 'mobile',
  country_iso: 'IN',
  lookup_status: 'ok',
};

function fakeClient(detail: Partial<LeadDetail>, history: PersonHistory = {}): LeadApiClient {
  return {
    getLead: vi.fn().mockResolvedValue(detail),
    getPerson: vi.fn().mockResolvedValue(history),
  } as unknown as LeadApiClient;
}

function baseDetail(overrides: Record<string, unknown> = {}): Partial<LeadDetail> {
  return {
    current: {
      updated_at: '2026-10-27T14:20:08.000Z',
      is_lead: true,
      lead_status: null,
      created_at: '2026-10-27T14:10:59.000Z',
      is_deleted: false,
      person_key: 'person:5528514a',
      ...overrides,
    },
    phone: VALID_PHONE,
    personKey: 'person:5528514a',
    answers: [],
  };
}

describe('reevaluateNeedsReviewLead', () => {
  it('reports not_found when the lead has no local processing record', async () => {
    findByLeadId.mockResolvedValue(null);

    const result = await reevaluateNeedsReviewLead('unknown-lead');

    expect(result).toEqual({ leadId: 'unknown-lead', outcome: 'not_found' });
    expect(reevaluateNeedsReviewDecision).not.toHaveBeenCalled();
  });

  it('refuses a lead that is not currently NEEDS_REVIEW', async () => {
    findByLeadId.mockResolvedValue(processingRow({ status: ProcessingStatus.ELIGIBLE }));

    const result = await reevaluateNeedsReviewLead('lead-1');

    expect(result.outcome).toBe('not_needs_review');
    expect(reevaluateNeedsReviewDecision).not.toHaveBeenCalled();
  });

  it('refuses a reason that is not on the explicit re-evaluable allow-list', async () => {
    findByLeadId.mockResolvedValue(processingRow({ decisionReason: 'some_future_reason' }));

    const result = await reevaluateNeedsReviewLead('lead-1', { client: fakeClient(baseDetail()) });

    expect(result.outcome).toBe('reason_not_reevaluable');
    expect(reevaluateNeedsReviewDecision).not.toHaveBeenCalled();
  });

  it('promotes to ELIGIBLE once the phone verdict has resolved, without calling when calling is disabled', async () => {
    findByLeadId.mockResolvedValue(processingRow());
    reevaluateNeedsReviewDecision.mockResolvedValue({
      applied: true,
      record: { ...processingRow(), status: ProcessingStatus.ELIGIBLE, version: 3 },
    });
    const callInitiator = vi.fn<() => Promise<OrchestratorResult>>();

    const result = await reevaluateNeedsReviewLead('lead-1', {
      client: fakeClient(baseDetail()),
      config: config({ RETELL_CALLING_ENABLED: 'false' }),
      callInitiator,
    });

    expect(result).toMatchObject({
      leadId: 'lead-1',
      outcome: 'promoted',
      previousReason: 'phone_verdict_unreadable',
      newReason: 'eligible',
    });
    expect(result.callOutcome).toBeUndefined();
    expect(callInitiator).not.toHaveBeenCalled();

    const applyCall = reevaluateNeedsReviewDecision.mock.calls[0]!;
    expect(applyCall[0]).toBe('proc-1');
    expect(applyCall[1]).toBe(2); // the row's version, used as the CAS guard
  });

  it('hands off to the orchestrator when freshly ELIGIBLE and calling is enabled', async () => {
    findByLeadId.mockResolvedValue(processingRow());
    reevaluateNeedsReviewDecision.mockResolvedValue({
      applied: true,
      record: { ...processingRow(), status: ProcessingStatus.ELIGIBLE },
    });
    const callInitiator = vi
      .fn()
      .mockResolvedValue({ outcome: 'call_initiated', leadId: 'lead-1' });

    const result = await reevaluateNeedsReviewLead('lead-1', {
      client: fakeClient(baseDetail()),
      config: config({ RETELL_CALLING_ENABLED: 'true' }),
      callInitiator: callInitiator as never,
    });

    expect(result.outcome).toBe('promoted');
    expect(result.callOutcome).toBe('call_initiated');
    expect(callInitiator).toHaveBeenCalledWith(
      'lead-1',
      expect.objectContaining({ config: expect.anything() }),
    );
  });

  it('resolves to SKIPPED when the lead has since been opted out (Unsubscribe) - never reaching the phone check', async () => {
    findByLeadId.mockResolvedValue(processingRow());
    reevaluateNeedsReviewDecision.mockResolvedValue({
      applied: true,
      record: { ...processingRow(), status: ProcessingStatus.SKIPPED },
    });
    const client = fakeClient(baseDetail({ lead_status: 'Unsubscribe' }));

    const result = await reevaluateNeedsReviewLead('lead-1', { client, config: config() });

    expect(result).toMatchObject({ outcome: 'resolved_skipped', newReason: 'status_blocked' });
    // The status check short-circuits list eligibility; the phone verdict is
    // never even read for this outcome.
    const applyCall = reevaluateNeedsReviewDecision.mock.calls[0]!;
    expect(applyCall[2]).toMatchObject({ reason: 'status_blocked' });
  });

  it('stays NEEDS_REVIEW (metadata refreshed) when the fresh check still cannot decide', async () => {
    findByLeadId.mockResolvedValue(processingRow());
    reevaluateNeedsReviewDecision.mockResolvedValue({
      applied: true,
      record: { ...processingRow(), status: ProcessingStatus.NEEDS_REVIEW },
    });
    // Phone verdict still absent - the exact original failure mode.
    const client = fakeClient({ ...baseDetail(), phone: null });

    const result = await reevaluateNeedsReviewLead('lead-1', { client, config: config() });

    expect(result).toMatchObject({ outcome: 'unchanged', newReason: 'phone_verdict_unreadable' });
  });

  it('reports race_not_applied and never calls the orchestrator when the CAS loses a race', async () => {
    findByLeadId.mockResolvedValue(processingRow());
    reevaluateNeedsReviewDecision.mockResolvedValue({ applied: false, record: processingRow() });
    const callInitiator = vi.fn();

    const result = await reevaluateNeedsReviewLead('lead-1', {
      client: fakeClient(baseDetail()),
      config: config({ RETELL_CALLING_ENABLED: 'true' }),
      callInitiator: callInitiator as never,
    });

    expect(result.outcome).toBe('race_not_applied');
    expect(callInitiator).not.toHaveBeenCalled();
  });

  it('never treats the lead as known-before-bootstrap during re-evaluation', async () => {
    // isBootstrapRun is hard-wired false inside the service; a row that would
    // otherwise look brand-new must still be judged on its merits, not skipped
    // as pre-existing.
    findByLeadId.mockResolvedValue(processingRow());
    reevaluateNeedsReviewDecision.mockResolvedValue({
      applied: true,
      record: { ...processingRow(), status: ProcessingStatus.ELIGIBLE },
    });

    const result = await reevaluateNeedsReviewLead('lead-1', {
      client: fakeClient(baseDetail()),
      config: config(),
    });

    expect(result.newReason).not.toBe('known_before_bootstrap');
  });
});
