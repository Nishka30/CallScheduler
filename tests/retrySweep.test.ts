import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetrySweeper, type RetrySweepConfig } from '../src/services/retrySweep.service.js';

const NOW = new Date('2026-06-01T12:00:00.000Z').getTime();

function cfg(overrides: Partial<RetrySweepConfig> = {}): RetrySweepConfig {
  return {
    callingEnabled: true,
    maxAttempts: 5,
    recheckMs: 300_000,
    maxWaitMs: 3_600_000, // 1h
    maxPerCycle: 10,
    batchSize: 50,
    ...overrides,
  };
}

function dueLead(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proc-1',
    leadId: 'lead-1',
    attemptCount: 1,
    version: 2,
    // last dial 10 min ago -> well within maxWait
    lastAttemptAt: new Date(NOW - 10 * 60_000),
    nextRetryAt: new Date(NOW - 60_000),
    ...overrides,
  };
}

let findDue: ReturnType<typeof vi.fn>;
let begin: ReturnType<typeof vi.fn>;
let reschedule: ReturnType<typeof vi.fn>;
let callInitiator: ReturnType<typeof vi.fn>;
let enqueueReviewNote: ReturnType<typeof vi.fn>;

function sweeper(config = cfg()) {
  return new RetrySweeper(config, {
    findDue,
    begin,
    reschedule,
    callInitiator,
    enqueueReviewNote,
    now: () => NOW,
  });
}

beforeEach(() => {
  findDue = vi.fn().mockResolvedValue([]);
  begin = vi.fn().mockResolvedValue(true);
  reschedule = vi.fn().mockResolvedValue(true);
  callInitiator = vi.fn().mockResolvedValue({ outcome: 'call_initiated', leadId: 'lead-1' });
  enqueueReviewNote = vi.fn().mockResolvedValue(true);
});

describe('RetrySweeper', () => {
  it('does nothing (and strands no lead) when calling is disabled', async () => {
    const summary = await sweeper(cfg({ callingEnabled: false })).runSweep();
    expect(findDue).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(summary.attempted).toBe(0);
  });

  it('claims a due retry and dials it through the orchestrator', async () => {
    findDue.mockResolvedValue([dueLead()]);

    const summary = await sweeper().runSweep();

    expect(begin).toHaveBeenCalledWith('proc-1', 2);
    expect(callInitiator).toHaveBeenCalledWith('lead-1');
    expect(summary.called).toBe(1);
  });

  it('does not dial when another worker already began the retry (race)', async () => {
    findDue.mockResolvedValue([dueLead()]);
    begin.mockResolvedValue(false);

    const summary = await sweeper().runSweep();

    expect(callInitiator).not.toHaveBeenCalled();
    expect(summary.races).toBe(1);
  });

  it('past max wait: surfaces ONCE to the CRM but keeps retrying (auto-resume, no give-up)', async () => {
    // last dial 2h ago, maxWait 1h -> past the wait, but DO NOT give up.
    findDue.mockResolvedValue([dueLead({ lastAttemptAt: new Date(NOW - 2 * 3_600_000) })]);

    const summary = await sweeper().runSweep();

    expect(enqueueReviewNote).toHaveBeenCalledWith(
      'lead-1',
      'retry_hold_unavailable',
      expect.any(String),
    );
    // Crucially, it STILL attempts (a hold may now be active) — auto-resume.
    expect(begin).toHaveBeenCalledWith('proc-1', 2);
    expect(callInitiator).toHaveBeenCalledWith('lead-1');
    expect(summary.waitingForHold).toBe(1);
  });

  it('counts a hold-expired retry as deferred (finalize already rescheduled it)', async () => {
    findDue.mockResolvedValue([dueLead()]);
    callInitiator.mockResolvedValue({ outcome: 'rejected_hold_expired', leadId: 'lead-1' });

    const summary = await sweeper().runSweep();

    expect(summary.deferredHold).toBe(1);
    // finalizeHoldExpired owns the reschedule, so the safety-net reschedule is not needed here
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('recovers a stranded lead (transient lead_unavailable) back to RETRY_PENDING', async () => {
    findDue.mockResolvedValue([dueLead()]);
    callInitiator.mockResolvedValue({ outcome: 'lead_unavailable', leadId: 'lead-1' });

    const summary = await sweeper().runSweep();

    expect(reschedule).toHaveBeenCalledWith('lead-1', new Date(NOW + 300_000));
    expect(summary.deferredError).toBe(1);
  });

  it('counts an eligibility/phone rejection as skipped (finalize set it terminal)', async () => {
    findDue.mockResolvedValue([dueLead()]);
    callInitiator.mockResolvedValue({ outcome: 'rejected_eligibility', leadId: 'lead-1' });

    const summary = await sweeper().runSweep();

    expect(summary.skipped).toBe(1);
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('respects the per-cycle cap', async () => {
    findDue.mockResolvedValue([
      dueLead({ id: 'a', leadId: 'la' }),
      dueLead({ id: 'b', leadId: 'lb' }),
      dueLead({ id: 'c', leadId: 'lc' }),
    ]);

    await sweeper(cfg({ maxPerCycle: 2 })).runSweep();

    expect(callInitiator).toHaveBeenCalledTimes(2);
  });

  it('a callInitiator throw never aborts the sweep; the lead is rescheduled', async () => {
    findDue.mockResolvedValue([dueLead()]);
    callInitiator.mockRejectedValue(new Error('boom'));

    const summary = await sweeper().runSweep();

    expect(summary.errors).toBe(1);
    expect(reschedule).toHaveBeenCalledWith('lead-1', new Date(NOW + 300_000));
  });
});
