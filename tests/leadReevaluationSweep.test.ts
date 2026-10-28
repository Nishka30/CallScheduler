import { describe, expect, it, vi } from 'vitest';
import {
  ReevaluationSweeper,
  type SweepConfig,
} from '../src/services/leadReevaluationSweep.service.js';
import type { ReevaluableLead } from '../src/repositories/leadProcessing.repository.js';
import type { ReevaluationResult } from '../src/services/leadReevaluation.service.js';
import { LeadApiError } from '../src/integrations/leadApi/errors.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const BASE: SweepConfig = {
  retryIntervalMs: 600_000, // 10 min
  backoffFactor: 2,
  maxAttempts: 3,
  maxPerCycle: 10,
  batchSize: 50,
};

function candidate(overrides: Partial<ReevaluableLead> = {}): ReevaluableLead {
  return {
    id: 'proc-1',
    leadId: 'lead-1',
    decisionReason: 'phone_verdict_unreadable',
    decidedAt: new Date('2026-10-27T14:00:00.000Z'),
    version: 2,
    ...overrides,
  };
}

/** A controllable clock. */
function clock(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const DECIDED = new Date('2026-10-27T14:00:00.000Z').getTime();

describe('ReevaluationSweeper — throttling', () => {
  it('does NOT re-evaluate a lead before its first retry interval elapses', async () => {
    const reevaluate = vi.fn<(id: string) => Promise<ReevaluationResult>>();
    const sweeper = new ReevaluationSweeper(BASE, {
      findCandidates: () => Promise.resolve([candidate()]),
      reevaluate,
      now: () => DECIDED + 60_000, // only 1 min after decision; interval is 10 min
    });

    const s = await sweeper.runSweep();

    expect(reevaluate).not.toHaveBeenCalled();
    expect(s).toMatchObject({ considered: 1, notDue: 1, attempted: 0 });
  });

  it('re-evaluates once the interval has elapsed (delayed phone verification resolves)', async () => {
    const reevaluate = vi
      .fn<(id: string) => Promise<ReevaluationResult>>()
      .mockResolvedValue({ leadId: 'lead-1', outcome: 'promoted', newReason: 'eligible' });
    const sweeper = new ReevaluationSweeper(BASE, {
      findCandidates: () => Promise.resolve([candidate()]),
      reevaluate,
      now: () => DECIDED + 11 * 60_000, // 11 min later -> due
    });

    const s = await sweeper.runSweep();

    expect(reevaluate).toHaveBeenCalledWith('lead-1');
    expect(s).toMatchObject({ attempted: 1, promoted: 1 });
  });

  it('caps Lead API re-evaluations at maxPerCycle', async () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      candidate({ leadId: `lead-${i}`, id: `p-${i}` }),
    );
    const reevaluate = vi.fn<(id: string) => Promise<ReevaluationResult>>().mockResolvedValue({
      leadId: 'x',
      outcome: 'unchanged',
      newReason: 'phone_verdict_unreadable',
    });
    const sweeper = new ReevaluationSweeper(
      { ...BASE, maxPerCycle: 2 },
      {
        findCandidates: () => Promise.resolve(candidates),
        reevaluate,
        now: () => DECIDED + 11 * 60_000,
      },
    );

    const s = await sweeper.runSweep();

    expect(reevaluate).toHaveBeenCalledTimes(2);
    expect(s.attempted).toBe(2);
  });
});

describe('ReevaluationSweeper — backoff and exhaustion', () => {
  it('applies exponential backoff between attempts and exhausts after maxAttempts', async () => {
    const c = clock(DECIDED);
    const reevaluate = vi.fn<(id: string) => Promise<ReevaluationResult>>().mockResolvedValue({
      leadId: 'lead-1',
      outcome: 'unchanged',
      newReason: 'phone_verdict_unreadable',
    });
    const sweeper = new ReevaluationSweeper(BASE, {
      findCandidates: () => Promise.resolve([candidate()]),
      reevaluate,
      now: c.now,
    });

    // Attempt 1 due at DECIDED + 10min.
    c.advance(10 * 60_000 + 1000);
    expect((await sweeper.runSweep()).attempted).toBe(1);

    // Attempt 2 due at DECIDED + 10min*2^1 = +20min. Not yet (only ~10min in).
    c.advance(1000);
    expect((await sweeper.runSweep()).attempted).toBe(0); // throttled by backoff

    // Advance to +20min -> attempt 2.
    c.advance(10 * 60_000);
    expect((await sweeper.runSweep()).attempted).toBe(1);

    // Attempt 3 due at DECIDED + 10min*2^2 = +40min.
    c.advance(20 * 60_000);
    const third = await sweeper.runSweep();
    expect(third.attempted).toBe(1);
    expect(third.newlyExhausted).toBe(1); // 3rd attempt hits maxAttempts=3

    // Now exhausted: never re-evaluated again, however far time advances.
    c.advance(1000 * 60_000);
    const after = await sweeper.runSweep();
    expect(after.attempted).toBe(0);
    expect(after.exhausted).toBe(1);
    expect(reevaluate).toHaveBeenCalledTimes(3);
  });
});

describe('ReevaluationSweeper — safety of outcomes', () => {
  it('drops a lead from retry state once promoted (ELIGIBLE), freeing the map', async () => {
    const reevaluate = vi
      .fn<(id: string) => Promise<ReevaluationResult>>()
      .mockResolvedValue({ leadId: 'lead-1', outcome: 'promoted', newReason: 'eligible' });
    const sweeper = new ReevaluationSweeper(BASE, {
      findCandidates: () => Promise.resolve([candidate()]),
      reevaluate,
      now: () => DECIDED + 11 * 60_000,
    });

    const s = await sweeper.runSweep();
    expect(s.promoted).toBe(1);
    // A promoted lead leaves NEEDS_REVIEW, so a later sweep that no longer lists
    // it simply forgets it — no leak, no further attempts.
  });

  it('counts a blocked-status resolution as resolved_skipped and never promotes it', async () => {
    const reevaluate = vi.fn<(id: string) => Promise<ReevaluationResult>>().mockResolvedValue({
      leadId: 'lead-1',
      outcome: 'resolved_skipped',
      newReason: 'status_blocked',
    });
    const sweeper = new ReevaluationSweeper(BASE, {
      findCandidates: () => Promise.resolve([candidate()]),
      reevaluate,
      now: () => DECIDED + 11 * 60_000,
    });

    const s = await sweeper.runSweep();
    expect(s).toMatchObject({ resolvedSkipped: 1, promoted: 0 });
  });

  it('counts a lost CAS race without crashing and keeps the lead for a later sweep', async () => {
    const reevaluate = vi
      .fn<(id: string) => Promise<ReevaluationResult>>()
      .mockResolvedValue({ leadId: 'lead-1', outcome: 'race_not_applied', newReason: 'eligible' });
    const sweeper = new ReevaluationSweeper(BASE, {
      findCandidates: () => Promise.resolve([candidate()]),
      reevaluate,
      now: () => DECIDED + 11 * 60_000,
    });

    const s = await sweeper.runSweep();
    expect(s.races).toBe(1);
    expect(s.attempted).toBe(1);
  });

  it('a transient re-evaluation error does not abort the sweep or exhaust the lead', async () => {
    const reevaluate = vi
      .fn<(id: string) => Promise<ReevaluationResult>>()
      .mockRejectedValueOnce(new Error('Lead API 503'))
      .mockResolvedValue({
        leadId: 'lead-2',
        outcome: 'unchanged',
        newReason: 'phone_verdict_unreadable',
      });
    const sweeper = new ReevaluationSweeper(BASE, {
      findCandidates: () =>
        Promise.resolve([
          candidate({ leadId: 'lead-1', id: 'p1' }),
          candidate({ leadId: 'lead-2', id: 'p2' }),
        ]),
      reevaluate,
      now: () => DECIDED + 11 * 60_000,
    });

    const s = await sweeper.runSweep();
    expect(s.errors).toBe(1);
    expect(s.stillUnchanged).toBe(1); // the second lead was still processed
    expect(reevaluate).toHaveBeenCalledTimes(2);
  });

  it('stops retrying after a PERMANENT Lead API error (e.g. 404) — never marks it terminal', async () => {
    const reevaluate = vi.fn<(id: string) => Promise<ReevaluationResult>>().mockRejectedValue(
      new LeadApiError('not_found', 'lead not found', {
        path: '/api/crm/leads/x',
        status: 404,
      }),
    );
    const sweeper = new ReevaluationSweeper(BASE, {
      findCandidates: () => Promise.resolve([candidate()]),
      reevaluate,
      now: () => DECIDED + 11 * 60_000,
    });

    const s1 = await sweeper.runSweep();
    expect(s1).toMatchObject({ attempted: 1, errors: 1, newlyExhausted: 1 });

    // A permanent failure is not retried on later sweeps (it stays NEEDS_REVIEW).
    const s2 = await sweeper.runSweep();
    expect(reevaluate).toHaveBeenCalledTimes(1);
    expect(s2).toMatchObject({ attempted: 0, exhausted: 1 });
  });

  it('retries a TRANSIENT error with backoff and exhausts after maxAttempts', async () => {
    const c = clock(DECIDED);
    const reevaluate = vi.fn<(id: string) => Promise<ReevaluationResult>>().mockRejectedValue(
      new LeadApiError('network', 'Lead API request timed out after 10000ms', {
        path: '/api/crm/persons/x',
      }),
    );
    const sweeper = new ReevaluationSweeper(BASE, {
      findCandidates: () => Promise.resolve([candidate()]),
      reevaluate,
      now: c.now,
    });

    c.advance(10 * 60_000 + 1000);
    expect((await sweeper.runSweep()).attempted).toBe(1); // attempt 1

    c.advance(1000);
    expect((await sweeper.runSweep()).attempted).toBe(0); // backed off (due at +20min)

    c.advance(10 * 60_000);
    expect((await sweeper.runSweep()).attempted).toBe(1); // attempt 2

    c.advance(20 * 60_000);
    const third = await sweeper.runSweep();
    expect(third.attempted).toBe(1); // attempt 3
    expect(third.newlyExhausted).toBe(1); // hit maxAttempts=3

    c.advance(1000 * 60_000);
    const after = await sweeper.runSweep();
    expect(after.attempted).toBe(0);
    expect(after.exhausted).toBe(1);
    expect(reevaluate).toHaveBeenCalledTimes(3); // bounded, never forever
  });

  it('treats a non-LeadApiError as transient (retried, not immediately exhausted)', async () => {
    const reevaluate = vi
      .fn<(id: string) => Promise<ReevaluationResult>>()
      .mockRejectedValue(new Error('socket hang up'));
    const sweeper = new ReevaluationSweeper(BASE, {
      findCandidates: () => Promise.resolve([candidate()]),
      reevaluate,
      now: () => DECIDED + 11 * 60_000,
    });

    const s = await sweeper.runSweep();
    expect(s).toMatchObject({ attempted: 1, errors: 1, newlyExhausted: 0 }); // one attempt < cap
  });

  it('re-evaluates only the explicit re-evaluable reasons (delegated to the query filter)', async () => {
    const findCandidates = vi
      .fn<(reasons: readonly string[], limit: number) => Promise<ReevaluableLead[]>>()
      .mockResolvedValue([]);
    const sweeper = new ReevaluationSweeper(BASE, { findCandidates, now: () => DECIDED });

    await sweeper.runSweep();

    const reasons = findCandidates.mock.calls[0]![0];
    expect(reasons).toContain('phone_verdict_unreadable');
    expect(reasons).toContain('awaiting_new_lead_rule_confirmation');
  });
});
