import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CallReconciliationSweeper,
  type CallReconcileConfig,
} from '../src/services/callReconciliation.service.js';

const NOW = new Date('2026-10-01T12:00:00.000Z').getTime();

function cfg(overrides: Partial<CallReconcileConfig> = {}): CallReconcileConfig {
  return {
    callingEnabled: true,
    stuckCallingMs: 1_800_000,
    stuckProcessingMs: 600_000,
    eligibleBackstopMs: 300_000,
    maxPerCycle: 20,
    batchSize: 100,
    ...overrides,
  };
}

let findStuckCalling: ReturnType<typeof vi.fn>;
let findStuckProcessing: ReturnType<typeof vi.fn>;
let findEligibleNotCalled: ReturnType<typeof vi.fn>;
let reconcileStuckCalling: ReturnType<typeof vi.fn>;
let requeueStuckProcessing: ReturnType<typeof vi.fn>;
let callInitiator: ReturnType<typeof vi.fn>;
let enqueueReviewNote: ReturnType<typeof vi.fn>;

function sweeper(config = cfg()) {
  return new CallReconciliationSweeper(config, {
    findStuckCalling,
    findStuckProcessing,
    findEligibleNotCalled,
    reconcileStuckCalling,
    requeueStuckProcessing,
    callInitiator,
    enqueueReviewNote,
    now: () => NOW,
  });
}

const lead = (o: Record<string, unknown> = {}) => ({
  id: 'p1',
  leadId: 'l1',
  version: 2,
  attemptCount: 1,
  ...o,
});

beforeEach(() => {
  findStuckCalling = vi.fn().mockResolvedValue([]);
  findStuckProcessing = vi.fn().mockResolvedValue([]);
  findEligibleNotCalled = vi.fn().mockResolvedValue([]);
  reconcileStuckCalling = vi.fn().mockResolvedValue(true);
  requeueStuckProcessing = vi.fn().mockResolvedValue(true);
  callInitiator = vi.fn().mockResolvedValue({ outcome: 'call_initiated', leadId: 'l1' });
  enqueueReviewNote = vi.fn().mockResolvedValue('sent');
});

describe('CallReconciliationSweeper', () => {
  it('reconciles a stuck CALLING lead and notifies the CRM (safe fallback, no redial)', async () => {
    findStuckCalling.mockResolvedValue([lead()]);

    const summary = await sweeper().runSweep();

    expect(findStuckCalling).toHaveBeenCalledWith(new Date(NOW - 1_800_000), 100);
    expect(reconcileStuckCalling).toHaveBeenCalledWith('p1', 2, new Date(NOW));
    expect(enqueueReviewNote).toHaveBeenCalledWith('l1', 'call_unreconciled', expect.any(String));
    expect(callInitiator).not.toHaveBeenCalled(); // never auto-redials a stuck call
    expect(summary.reconciledCalling).toBe(1);
  });

  it('requeues a stuck PROCESSING lead back to ELIGIBLE (no dial happened there)', async () => {
    findStuckProcessing.mockResolvedValue([lead()]);

    const summary = await sweeper().runSweep();

    expect(findStuckProcessing).toHaveBeenCalledWith(new Date(NOW - 600_000), 100);
    expect(requeueStuckProcessing).toHaveBeenCalledWith('p1', 2, new Date(NOW));
    expect(summary.requeuedProcessing).toBe(1);
  });

  it('backstops a stranded ELIGIBLE lead through the orchestrator (all gates apply)', async () => {
    findEligibleNotCalled.mockResolvedValue([lead()]);

    const summary = await sweeper().runSweep();

    expect(findEligibleNotCalled).toHaveBeenCalledWith(new Date(NOW - 300_000), 100);
    expect(callInitiator).toHaveBeenCalledWith('l1');
    expect(summary.backstopAttempted).toBe(1);
  });

  it('does NOT run the ELIGIBLE backstop when calling is disabled (never strands a lead)', async () => {
    findEligibleNotCalled.mockResolvedValue([lead()]);

    await sweeper(cfg({ callingEnabled: false })).runSweep();

    expect(findEligibleNotCalled).not.toHaveBeenCalled();
    expect(callInitiator).not.toHaveBeenCalled();
  });

  it('counts a lost CAS race without erroring', async () => {
    findStuckCalling.mockResolvedValue([lead()]);
    reconcileStuckCalling.mockResolvedValue(false);

    const summary = await sweeper().runSweep();

    expect(summary.races).toBe(1);
    expect(enqueueReviewNote).not.toHaveBeenCalled(); // only notify when the CAS applied
  });

  it('contains errors in one phase so the others still run', async () => {
    findStuckCalling.mockRejectedValue(new Error('db blip'));
    findStuckProcessing.mockResolvedValue([lead()]);

    const summary = await sweeper().runSweep();

    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(requeueStuckProcessing).toHaveBeenCalled(); // processing phase still ran
  });
});
