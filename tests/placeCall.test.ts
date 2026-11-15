import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetellApiError } from '../src/integrations/retell/errors.js';
import type { RetellClient } from '../src/integrations/retell/client.js';
import type { LeadCallContext } from '../src/services/leadContext.service.js';

/**
 * Focused tests for the extracted `placeCall` call-placement primitive.
 *
 * The full gating/claim/duplicate behavior of the orchestrator is already proven
 * through the public `initiateCallForLead` in `callOrchestrator.test.ts`; those
 * tests passing unchanged after the extraction is the behavior-parity proof.
 *
 * This file proves the SECOND half of the extraction goal: that `placeCall` is a
 * genuinely reusable primitive that can be invoked in isolation (as Step 3's
 * queue flow will), that it dials an already-approved/already-claimed lead
 * correctly, that it builds the agent dynamic variables from the context it is
 * given, and that it makes NO eligibility/claim/duplicate decisions of its own.
 */

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

// Claim/duplicate repositories: mocked ONLY so we can assert placeCall never
// touches them (it must not make claim/duplicate decisions). completeProcessing
// is used by the shared failure handler for a permanent provider error.
vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  claimEligibleLead: vi.fn(),
  markCalling: vi.fn(),
  completeProcessing: vi.fn(),
  finalizeRejectedEligibleLead: vi.fn(),
  finalizeHoldExpired: vi.fn(),
}));

vi.mock('../src/repositories/callRecord.repository.js', () => ({
  recordCallAttempt: vi.fn(),
  attachProviderCallId: vi.fn(),
  markCallAttemptFailed: vi.fn(),
}));

const deliverCallNote = vi.fn();
vi.mock('../src/services/callNoteDelivery.service.js', () => ({
  deliverCallNote: (...args: unknown[]) => deliverCallNote(...args),
}));

vi.mock('../src/services/reviewNoteDelivery.service.js', () => ({
  enqueueReviewNote: vi.fn().mockResolvedValue(true),
}));

const { placeCall } = await import('../src/services/callOrchestrator.service.js');
const { claimEligibleLead, markCalling, completeProcessing } = await import(
  '../src/repositories/leadProcessing.repository.js'
);
const { recordCallAttempt, attachProviderCallId, markCallAttemptFailed } = await import(
  '../src/repositories/callRecord.repository.js'
);

const NOW = new Date('2026-10-16T12:00:00.000Z');

function ctx(overrides: Partial<LeadCallContext> = {}): LeadCallContext {
  return { leadId: 'lead-1', answers: [], leadFields: {}, ...overrides };
}

function params(overrides: Record<string, unknown> = {}) {
  const createPhoneCall =
    overrides.retellResult instanceof Error
      ? vi.fn().mockRejectedValue(overrides.retellResult)
      : vi.fn().mockResolvedValue(overrides.retellResult ?? { callId: 'retell_abc' });
  const retellClient = { createPhoneCall } as unknown as RetellClient;
  return {
    leadId: 'lead-1',
    toNumber: '+447700900123',
    context: (overrides.context as LeadCallContext | undefined) ?? ctx(),
    callRecordId: 'call-1',
    processingId: 'proc-1',
    processingVersion: 2,
    retellClient,
    now: () => NOW,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(completeProcessing).mockResolvedValue(true);
  vi.mocked(attachProviderCallId).mockResolvedValue({ id: 'call-1' } as never);
  vi.mocked(markCallAttemptFailed).mockResolvedValue({ id: 'call-1', leadId: 'lead-1' } as never);
  deliverCallNote.mockResolvedValue('sent');
});

describe('placeCall — reusable call-placement primitive', () => {
  it('dials the validated E.164 and links the provider call id', async () => {
    const p = params();

    const result = await placeCall(p);

    expect(result).toMatchObject({
      outcome: 'call_initiated',
      leadId: 'lead-1',
      callRecordId: 'call-1',
      retellCallId: 'retell_abc',
    });
    const callArg = (p.retellClient.createPhoneCall as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.toNumber).toBe('+447700900123');
    expect(callArg.idempotencyKey).toBe('call-1');
    expect(callArg.metadata).toEqual({ leadId: 'lead-1', callRecordId: 'call-1' });
    expect(attachProviderCallId).toHaveBeenCalledWith('call-1', 'retell_abc', NOW);
  });

  it('makes NO claim/duplicate decisions (the caller already did that)', async () => {
    const p = params();

    await placeCall(p);

    expect(claimEligibleLead).not.toHaveBeenCalled();
    expect(markCalling).not.toHaveBeenCalled();
    expect(recordCallAttempt).not.toHaveBeenCalled();
  });

  it('builds the agent dynamic variables from the context it is given', async () => {
    const p = params({ context: ctx({ customerName: 'John Smyth', brand: 'himalayan' }) });

    await placeCall(p);

    const callArg = (p.retellClient.createPhoneCall as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.dynamicVariables).toEqual({
      customer_name: 'John Smyth',
      brand_name: 'himalayan',
    });
  });

  it('omits dynamic variables when the context has no name or brand', async () => {
    const p = params(); // base context has neither

    await placeCall(p);

    const callArg = (p.retellClient.createPhoneCall as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.dynamicVariables).toBeUndefined();
  });

  it('treats a provider timeout/5xx as uncertain: never finalises, never retries', async () => {
    const p = params({
      retellResult: new RetellApiError('network', 'timed out', { path: '/v2/create-phone-call' }),
    });

    const result = await placeCall(p);

    expect(result.outcome).toBe('provider_uncertain');
    expect(completeProcessing).not.toHaveBeenCalled();
    expect(p.retellClient.createPhoneCall).toHaveBeenCalledTimes(1);
  });

  it('marks FAILED on a permanent provider error, using the processing id/version it was given', async () => {
    const p = params({
      retellResult: new RetellApiError('auth', 'bad key', { path: '/x', status: 401 }),
    });

    const result = await placeCall(p);

    expect(result).toMatchObject({ outcome: 'provider_failed', reason: 'auth' });
    expect(completeProcessing).toHaveBeenCalledWith('proc-1', 2, 'FAILED', expect.anything());
    expect(markCallAttemptFailed).toHaveBeenCalledWith('call-1', 'auth');
  });
});
