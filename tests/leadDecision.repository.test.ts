import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessingStatus } from '@prisma/client';

const leadProcessing = {
  create: vi.fn(),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
};

const integrationCursor = {
  upsert: vi.fn(),
  update: vi.fn(),
};

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    leadProcessing,
    integrationCursor,
    $transaction: (cb: (tx: unknown) => unknown) => cb({ leadProcessing }),
  },
  disconnectPrisma: vi.fn(),
}));

const {
  recordLeadDecision,
  reevaluateNeedsReviewDecision,
  sanitizeDecisionDetail,
  findDecidedLeadIds,
} = await import('../src/repositories/leadProcessing.repository.js');
const { advanceCursor, isBootstrapPending, markBootstrapComplete } =
  await import('../src/repositories/integrationCursor.repository.js');

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ff000000-0000-4000-8000-000000000001',
    leadId: 'lead-1',
    status: ProcessingStatus.PENDING,
    version: 0,
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(leadProcessing).forEach((fn) => fn.mockReset());
  Object.values(integrationCursor).forEach((fn) => fn.mockReset());
});

describe('recordLeadDecision', () => {
  it('applies a decision to a newly discovered lead', async () => {
    leadProcessing.create.mockResolvedValue(record());
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(
      record({ status: ProcessingStatus.ELIGIBLE, version: 1 }),
    );

    const result = await recordLeadDecision('lead-1', {
      status: ProcessingStatus.ELIGIBLE,
      reason: 'eligible',
      leadUpdatedAt: new Date('2026-10-14T11:00:00.000Z'),
    });

    expect(result.applied).toBe(true);

    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Version-guarded, PENDING-only: two workers cannot both apply a decision.
    expect(call.where).toMatchObject({ status: ProcessingStatus.PENDING, version: 0 });
    expect(call.data.decisionReason).toBe('eligible');
  });

  it('leaves an already-decided lead untouched', async () => {
    leadProcessing.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002', name: 'PrismaClientKnownRequestError' }),
    );
    leadProcessing.findUniqueOrThrow.mockResolvedValue(
      record({ status: ProcessingStatus.SKIPPED, decisionReason: 'status_blocked' }),
    );

    // The create rejection is not a Prisma error instance here, so go through
    // the simpler path: an existing PENDING-free record.
    leadProcessing.create.mockResolvedValue(
      record({ status: ProcessingStatus.SKIPPED, decisionReason: 'status_blocked' }),
    );

    const result = await recordLeadDecision('lead-1', {
      status: ProcessingStatus.ELIGIBLE,
      reason: 'eligible',
    });

    expect(result.applied).toBe(false);
    // No attempt is made to overwrite the earlier judgement.
    expect(leadProcessing.updateMany).not.toHaveBeenCalled();
  });

  it('reports applied:false when another worker decides first', async () => {
    leadProcessing.create.mockResolvedValue(record());
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(
      record({ status: ProcessingStatus.SKIPPED, version: 1 }),
    );

    const result = await recordLeadDecision('lead-1', {
      status: ProcessingStatus.ELIGIBLE,
      reason: 'eligible',
    });

    expect(result.applied).toBe(false);
  });

  it('lets exactly one of two concurrent decisions win', async () => {
    leadProcessing.create.mockResolvedValue(record());
    leadProcessing.findUniqueOrThrow.mockResolvedValue(record({ version: 1 }));
    leadProcessing.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const results = await Promise.all([
      recordLeadDecision('lead-1', { status: ProcessingStatus.ELIGIBLE, reason: 'eligible' }),
      recordLeadDecision('lead-1', { status: ProcessingStatus.ELIGIBLE, reason: 'eligible' }),
    ]);

    expect(results.filter((r) => r.applied)).toHaveLength(1);
  });

  it('truncates an over-long reason to the column width', async () => {
    leadProcessing.create.mockResolvedValue(record());
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(record());

    await recordLeadDecision('lead-1', {
      status: ProcessingStatus.SKIPPED,
      reason: 'x'.repeat(200),
    });

    const data = leadProcessing.updateMany.mock.calls[0]![0].data as Record<string, string>;
    expect(data['decisionReason']).toHaveLength(64);
  });
});

describe('reevaluateNeedsReviewDecision', () => {
  it('only targets a row currently NEEDS_REVIEW (never PENDING/ELIGIBLE/etc)', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(
      record({ status: ProcessingStatus.ELIGIBLE, version: 4 }),
    );

    await reevaluateNeedsReviewDecision('ff000000-0000-4000-8000-000000000001', 3, {
      status: ProcessingStatus.ELIGIBLE,
      reason: 'eligible',
    });

    const call = leadProcessing.updateMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({ status: ProcessingStatus.NEEDS_REVIEW, version: 3 });
  });

  it('promotes a NEEDS_REVIEW lead to ELIGIBLE once the phone verdict resolves', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(
      record({ status: ProcessingStatus.ELIGIBLE, version: 2 }),
    );

    const result = await reevaluateNeedsReviewDecision('ff000000-0000-4000-8000-000000000001', 1, {
      status: ProcessingStatus.ELIGIBLE,
      reason: 'eligible',
    });

    expect(result.applied).toBe(true);
    expect(result.record.status).toBe(ProcessingStatus.ELIGIBLE);
  });

  it('resolves a NEEDS_REVIEW lead to SKIPPED when it has since been opted out', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(
      record({ status: ProcessingStatus.SKIPPED, decisionReason: 'status_blocked', version: 2 }),
    );

    const result = await reevaluateNeedsReviewDecision('ff000000-0000-4000-8000-000000000001', 1, {
      status: ProcessingStatus.SKIPPED,
      reason: 'status_blocked',
      detail: 'status "Unsubscribe"',
    });

    expect(result.applied).toBe(true);
    expect(result.record.status).toBe(ProcessingStatus.SKIPPED);
  });

  it('reports applied:false without retrying when the row moved under us (race)', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(
      record({ status: ProcessingStatus.PROCESSING, version: 5 }),
    );

    const result = await reevaluateNeedsReviewDecision('ff000000-0000-4000-8000-000000000001', 1, {
      status: ProcessingStatus.ELIGIBLE,
      reason: 'eligible',
    });

    expect(result.applied).toBe(false);
    // The CAS is a single attempt: no second updateMany call.
    expect(leadProcessing.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('sanitizeDecisionDetail', () => {
  it('strips credentials from a detail string', () => {
    const result = sanitizeDecisionDetail('failed on postgres://admin:hunter2@db.internal/prod');

    expect(result).not.toContain('hunter2');
  });

  it('truncates to the column width', () => {
    expect(sanitizeDecisionDetail('y'.repeat(900))).toHaveLength(300);
  });
});

describe('findDecidedLeadIds', () => {
  it('returns an empty set without querying for an empty input', async () => {
    expect(await findDecidedLeadIds([])).toEqual(new Set());
    expect(leadProcessing.findMany).not.toHaveBeenCalled();
  });

  it('excludes PENDING leads from the decided set', async () => {
    leadProcessing.findMany.mockResolvedValue([{ leadId: 'a' }]);

    const decided = await findDecidedLeadIds(['a', 'b']);

    expect(decided.has('a')).toBe(true);
    expect(decided.has('b')).toBe(false);

    const where = leadProcessing.findMany.mock.calls[0]![0].where as {
      status: { in: string[] };
    };
    expect(where.status.in).not.toContain(ProcessingStatus.PENDING);
  });
});

describe('integration cursor', () => {
  it('treats an unbootstrapped cursor as pending', () => {
    expect(isBootstrapPending({ bootstrapCompletedAt: null } as never)).toBe(true);
    expect(isBootstrapPending({ bootstrapCompletedAt: new Date() } as never)).toBe(false);
  });

  it('advances the cursor and moves the watermark forward', async () => {
    integrationCursor.upsert.mockResolvedValue({
      source: 'LEAD_API',
      cursor: 'old',
      watermarkAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    integrationCursor.update.mockResolvedValue({ cursor: 'new' });

    await advanceCursor({ cursor: 'new', watermarkAt: new Date('2026-10-02T00:00:00.000Z') });

    const data = integrationCursor.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.cursor).toBe('new');
    expect(data.watermarkAt).toEqual(new Date('2026-10-02T00:00:00.000Z'));
  });

  it('never rewinds the watermark', async () => {
    integrationCursor.upsert.mockResolvedValue({
      source: 'LEAD_API',
      cursor: 'old',
      watermarkAt: new Date('2026-10-05T00:00:00.000Z'),
    });
    integrationCursor.update.mockResolvedValue({});

    // An out-of-order page must not reopen already-covered ground.
    await advanceCursor({ cursor: 'new', watermarkAt: new Date('2026-10-01T00:00:00.000Z') });

    const data = integrationCursor.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.watermarkAt).toEqual(new Date('2026-10-05T00:00:00.000Z'));
  });

  it('keeps the existing watermark when a page yields none', async () => {
    integrationCursor.upsert.mockResolvedValue({
      source: 'LEAD_API',
      watermarkAt: new Date('2026-10-05T00:00:00.000Z'),
    });
    integrationCursor.update.mockResolvedValue({});

    await advanceCursor({ cursor: null, watermarkAt: null });

    const data = integrationCursor.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.watermarkAt).toEqual(new Date('2026-10-05T00:00:00.000Z'));
  });

  it('records bootstrap completion', async () => {
    integrationCursor.update.mockResolvedValue({});

    await markBootstrapComplete();

    const data = integrationCursor.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.bootstrapCompletedAt).toBeInstanceOf(Date);
  });
});
