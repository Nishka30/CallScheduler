import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import type { DueStatusReport } from '../src/repositories/leadProcessing.repository.js';
import type { DeliverResult } from '../src/services/guidedBoostStatus.service.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  findStatusReportsForRetry: vi.fn(),
  claimStatusReportForRetry: vi.fn(),
}));

const { StatusReconciliationSweeper, buildStatusReconciliationSweeper } = await import(
  '../src/services/statusReconciliation.service.js'
);

function config(over: Record<string, string> = {}) {
  return parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', LEAD_API_KEY_CALLER: 'k', ...over });
}

const SWEEP_CONFIG = { maxAttempts: 5, backoffMs: 300_000, maxPerCycle: 20, batchSize: 100 };

function due(over: Partial<DueStatusReport> = {}): DueStatusReport {
  return {
    leadId: 'lead-1',
    lastFinalStatus: 'reached_no_booking',
    statusReportReason: null,
    statusReportAttempts: 1,
    ...over,
  };
}

function deliverStub(outcome: DeliverResult['outcome']) {
  return vi.fn<(leadId: string, status: string, reason: string | null) => Promise<DeliverResult>>(
    () => Promise.resolve({ outcome, status: 'reached_no_booking' }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('StatusReconciliationSweeper (retry via shared deliver)', () => {
  it('claims then delivers the PERSISTED status + reason (no re-derivation)', async () => {
    const deliver = deliverStub('sent');
    const s = new StatusReconciliationSweeper(SWEEP_CONFIG, {
      findDue: vi.fn().mockResolvedValue([due({ lastFinalStatus: 'no_answer', statusReportReason: 'busy' })]),
      claim: vi.fn().mockResolvedValue(true),
      deliver,
      now: () => 1_000,
    });

    const summary = await s.runSweep();

    expect(summary.sent).toBe(1);
    expect(deliver).toHaveBeenCalledWith('lead-1', 'no_answer', 'busy');
  });

  it('409 → counted as conflict', async () => {
    const s = new StatusReconciliationSweeper(SWEEP_CONFIG, {
      findDue: vi.fn().mockResolvedValue([due()]),
      claim: vi.fn().mockResolvedValue(true),
      deliver: deliverStub('conflict'),
      now: () => 1_000,
    });
    expect((await s.runSweep()).conflict).toBe(1);
  });

  it('failure → counted failed (remains retryable)', async () => {
    const s = new StatusReconciliationSweeper(SWEEP_CONFIG, {
      findDue: vi.fn().mockResolvedValue([due()]),
      claim: vi.fn().mockResolvedValue(true),
      deliver: deliverStub('failed'),
      now: () => 1_000,
    });
    expect((await s.runSweep()).failed).toBe(1);
  });

  it('lost lease → does not deliver (concurrency guard)', async () => {
    const deliver = deliverStub('sent');
    const s = new StatusReconciliationSweeper(SWEEP_CONFIG, {
      findDue: vi.fn().mockResolvedValue([due()]),
      claim: vi.fn().mockResolvedValue(false),
      deliver,
      now: () => 1_000,
    });
    const summary = await s.runSweep();
    expect(summary.skippedLease).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('honors maxPerCycle', async () => {
    const deliver = deliverStub('sent');
    const s = new StatusReconciliationSweeper(
      { ...SWEEP_CONFIG, maxPerCycle: 1 },
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

  it('passes the attempt cap to the due query', async () => {
    const findDue = vi.fn().mockResolvedValue([]);
    await new StatusReconciliationSweeper(SWEEP_CONFIG, {
      findDue,
      claim: vi.fn().mockResolvedValue(true),
      deliver: deliverStub('sent'),
      now: () => 1_000,
    }).runSweep();
    expect(findDue).toHaveBeenCalledWith(expect.any(Date), 5, 100);
  });
});

describe('buildStatusReconciliationSweeper — feature flag', () => {
  it('returns null when disabled (default)', () => {
    expect(buildStatusReconciliationSweeper(config())).toBeNull();
  });
  it('builds a sweeper when enabled', () => {
    expect(
      buildStatusReconciliationSweeper(config({ CALLER_STATUS_RECONCILE_ENABLED: 'true' })),
    ).toBeInstanceOf(StatusReconciliationSweeper);
  });
});
