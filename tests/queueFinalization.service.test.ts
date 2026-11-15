import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import type { DueStatusReport } from '../src/repositories/leadProcessing.repository.js';
import type { DeliverResult } from '../src/services/guidedBoostStatus.service.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  findPendingFinalizations: vi.fn(),
  claimPendingFinalization: vi.fn(),
}));

const { FinalizationSweeper, buildFinalizationSweeper } = await import(
  '../src/services/queueFinalization.service.js'
);

function config() {
  return parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', LEAD_API_KEY_CALLER: 'k' });
}

const CFG = { leaseMs: 300_000, maxPerCycle: 20, batchSize: 100 };

function due(over: Partial<DueStatusReport> = {}): DueStatusReport {
  return {
    leadId: 'lead-1',
    lastFinalStatus: 'reached_no_booking',
    statusReportReason: null,
    statusReportAttempts: 0,
    ...over,
  };
}

function deliverStub(outcome: DeliverResult['outcome']) {
  return vi.fn<(leadId: string, status: string, reason: string | null) => Promise<DeliverResult>>(
    () => Promise.resolve({ outcome, status: 'reached_no_booking' }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('FinalizationSweeper', () => {
  it('claims a due pending finalization then delivers the persisted status + reason', async () => {
    const deliver = deliverStub('sent');
    const s = new FinalizationSweeper(CFG, {
      findDue: vi.fn().mockResolvedValue([due({ lastFinalStatus: 'booked', statusReportReason: null })]),
      claim: vi.fn().mockResolvedValue(true),
      deliver,
      now: () => 1_000,
    });

    const summary = await s.runSweep();

    expect(summary.sent).toBe(1);
    expect(deliver).toHaveBeenCalledWith('lead-1', 'booked', null);
  });

  it('lost lease → does not deliver (concurrency)', async () => {
    const deliver = deliverStub('sent');
    const s = new FinalizationSweeper(CFG, {
      findDue: vi.fn().mockResolvedValue([due()]),
      claim: vi.fn().mockResolvedValue(false),
      deliver,
      now: () => 1_000,
    });
    const summary = await s.runSweep();
    expect(summary.skippedLease).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('failed delivery is counted (then Step 7 retries it)', async () => {
    const s = new FinalizationSweeper(CFG, {
      findDue: vi.fn().mockResolvedValue([due()]),
      claim: vi.fn().mockResolvedValue(true),
      deliver: deliverStub('failed'),
      now: () => 1_000,
    });
    expect((await s.runSweep()).failed).toBe(1);
  });

  it('honors maxPerCycle', async () => {
    const deliver = deliverStub('sent');
    const s = new FinalizationSweeper(
      { ...CFG, maxPerCycle: 1 },
      {
        findDue: vi.fn().mockResolvedValue([due({ leadId: 'a' }), due({ leadId: 'b' })]),
        claim: vi.fn().mockResolvedValue(true),
        deliver,
        now: () => 1_000,
      },
    );
    await s.runSweep();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('buildFinalizationSweeper is always built (core flow, not flag-gated)', () => {
    expect(buildFinalizationSweeper(config())).toBeInstanceOf(FinalizationSweeper);
  });
});
