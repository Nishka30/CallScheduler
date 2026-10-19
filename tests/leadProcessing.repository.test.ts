import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, ProcessingStatus } from '@prisma/client';

/**
 * Prisma is fully mocked: these tests assert the concurrency *contract* of the
 * repository (what it asks the database to do) without requiring a database.
 */
const leadProcessing = {
  create: vi.fn(),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  updateMany: vi.fn(),
};

const prismaMock = {
  leadProcessing,
  // Run the callback inline against the same mocked delegate.
  $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({ leadProcessing })),
};

vi.mock('../src/lib/prisma.js', () => ({
  prisma: prismaMock,
  disconnectPrisma: vi.fn(),
}));

const {
  claimLeadForProcessing,
  claimEligibleLead,
  completeProcessing,
  ensureProcessingRecord,
  markCalling,
  requeueForRetry,
  sanitizeErrorMessage,
} = await import('../src/repositories/leadProcessing.repository.js');

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ff000000-0000-4000-8000-000000000001',
    leadId: 'lead-1',
    status: ProcessingStatus.PENDING,
    attemptCount: 0,
    version: 3,
    claimedAt: null,
    claimedBy: null,
    lastAttemptAt: null,
    lastError: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

beforeEach(() => {
  Object.values(leadProcessing).forEach((fn) => fn.mockReset());
  prismaMock.$transaction.mockClear();
});

describe('ensureProcessingRecord', () => {
  it('creates a record the first time a lead is seen', async () => {
    const created = record();
    leadProcessing.create.mockResolvedValue(created);

    const result = await ensureProcessingRecord('lead-1');

    expect(result).toEqual({ record: created, created: true });
    expect(leadProcessing.create).toHaveBeenCalledWith({ data: { leadId: 'lead-1' } });
  });

  it('reports created:false for a lead already in the workflow', async () => {
    const existing = record({ status: ProcessingStatus.COMPLETED });
    leadProcessing.create.mockRejectedValue(uniqueConstraintError());
    leadProcessing.findUniqueOrThrow.mockResolvedValue(existing);

    const result = await ensureProcessingRecord('lead-1');

    // This is what stops an already-processed lead being re-called when it
    // reappears in a later polling page.
    expect(result).toEqual({ record: existing, created: false });
  });

  it('propagates errors that are not unique-constraint violations', async () => {
    leadProcessing.create.mockRejectedValue(new Error('connection lost'));

    await expect(ensureProcessingRecord('lead-1')).rejects.toThrow('connection lost');
    expect(leadProcessing.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('claimEligibleLead', () => {
  it('claims an ELIGIBLE lead with a version-guarded conditional update', async () => {
    const eligible = record({ status: ProcessingStatus.ELIGIBLE });
    const claimed = record({ status: ProcessingStatus.PROCESSING, version: 4 });
    const now = new Date('2026-02-01T10:00:00.000Z');

    leadProcessing.findUnique.mockResolvedValue(eligible);
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(claimed);

    const result = await claimEligibleLead('lead-1', 'worker-a', now);

    expect(result).toEqual(claimed);
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({ status: ProcessingStatus.ELIGIBLE, version: 3 });
    expect(call.data.status).toBe(ProcessingStatus.PROCESSING);
    expect(call.data.claimedBy).toBe('worker-a');
  });

  it('refuses to claim a lead that is not ELIGIBLE', async () => {
    leadProcessing.findUnique.mockResolvedValue(record({ status: ProcessingStatus.PENDING }));

    const result = await claimEligibleLead('lead-1', 'worker-a');

    expect(result).toBeNull();
    expect(leadProcessing.updateMany).not.toHaveBeenCalled();
  });

  it('returns null when another worker wins the race', async () => {
    leadProcessing.findUnique.mockResolvedValue(record({ status: ProcessingStatus.ELIGIBLE }));
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });

    expect(await claimEligibleLead('lead-1', 'worker-b')).toBeNull();
    expect(leadProcessing.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('returns null for an unknown lead', async () => {
    leadProcessing.findUnique.mockResolvedValue(null);
    expect(await claimEligibleLead('missing', 'worker-a')).toBeNull();
  });
});

describe('claimLeadForProcessing', () => {
  it('claims a PENDING lead with a version-guarded conditional update', async () => {
    const pending = record();
    const claimed = record({ status: ProcessingStatus.PROCESSING, version: 4, attemptCount: 1 });
    const now = new Date('2026-02-01T10:00:00.000Z');

    leadProcessing.findUnique.mockResolvedValue(pending);
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(claimed);

    const result = await claimLeadForProcessing('lead-1', 'worker-a', now);

    expect(result).toEqual(claimed);
    expect(leadProcessing.updateMany).toHaveBeenCalledWith({
      where: {
        id: pending.id,
        status: ProcessingStatus.PENDING,
        version: 3,
      },
      data: {
        status: ProcessingStatus.PROCESSING,
        version: { increment: 1 },
        attemptCount: { increment: 1 },
        claimedAt: now,
        claimedBy: 'worker-a',
        lastAttemptAt: now,
      },
    });
  });

  it('returns null when another worker wins the race', async () => {
    leadProcessing.findUnique.mockResolvedValue(record());
    // Zero rows updated => the version moved between our read and our write.
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });

    const result = await claimLeadForProcessing('lead-1', 'worker-b');

    expect(result).toBeNull();
    expect(leadProcessing.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('refuses to claim a lead that is not PENDING', async () => {
    leadProcessing.findUnique.mockResolvedValue(record({ status: ProcessingStatus.CALLING }));

    const result = await claimLeadForProcessing('lead-1', 'worker-a');

    expect(result).toBeNull();
    expect(leadProcessing.updateMany).not.toHaveBeenCalled();
  });

  it('returns null for an unknown lead', async () => {
    leadProcessing.findUnique.mockResolvedValue(null);

    expect(await claimLeadForProcessing('missing', 'worker-a')).toBeNull();
    expect(leadProcessing.updateMany).not.toHaveBeenCalled();
  });

  it('runs the read and the conditional update inside one transaction', async () => {
    leadProcessing.findUnique.mockResolvedValue(record());
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(record());

    await claimLeadForProcessing('lead-1', 'worker-a');

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it('lets exactly one of two concurrent workers win', async () => {
    const pending = record();
    leadProcessing.findUnique.mockResolvedValue(pending);
    leadProcessing.findUniqueOrThrow.mockResolvedValue(
      record({ status: ProcessingStatus.PROCESSING, version: 4 }),
    );
    // First conditional update matches; the second finds version already bumped.
    leadProcessing.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const [first, second] = await Promise.all([
      claimLeadForProcessing('lead-1', 'worker-a'),
      claimLeadForProcessing('lead-1', 'worker-b'),
    ]);

    expect([first, second].filter((r) => r !== null)).toHaveLength(1);
  });
});

describe('markCalling', () => {
  it('transitions a PROCESSING lead to CALLING with a version-guarded update', async () => {
    const calling = record({ status: ProcessingStatus.CALLING, version: 5 });
    const now = new Date('2026-03-01T09:00:00.000Z');
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    leadProcessing.findUniqueOrThrow.mockResolvedValue(calling);

    const result = await markCalling('id-1', 4, now);

    expect(result).toEqual(calling);
    expect(leadProcessing.updateMany).toHaveBeenCalledWith({
      where: { id: 'id-1', version: 4, status: ProcessingStatus.PROCESSING },
      data: {
        status: ProcessingStatus.CALLING,
        version: { increment: 1 },
        lastAttemptAt: now,
      },
    });
  });

  it('returns null when a conflicting claim already advanced the row', async () => {
    // version moved, or the lead is no longer PROCESSING -> do not double-dial.
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });

    const result = await markCalling('id-1', 4);

    expect(result).toBeNull();
    expect(leadProcessing.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('completeProcessing', () => {
  it('releases the claim and stores a sanitized failure reason', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const ok = await completeProcessing(
      'id-1',
      4,
      ProcessingStatus.FAILED,
      new Error('call failed for postgres://admin:hunter2@db.internal:5432/prod'),
    );

    expect(ok).toBe(true);

    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: 'id-1', version: 4 });
    expect(call.data.claimedAt).toBeNull();
    expect(call.data.claimedBy).toBeNull();
    expect(call.data.lastError).not.toContain('hunter2');
  });

  it('returns false when the version guard no longer matches', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });

    expect(await completeProcessing('id-1', 2, ProcessingStatus.COMPLETED)).toBe(false);
  });
});

describe('requeueForRetry', () => {
  it('only requeues leads that have not reached the CALLING state', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    await requeueForRetry('id-1', 4, 'transient lookup failure');

    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: { status: { in: string[] } };
    };

    // An in-flight outbound call may already have reached a real customer, so
    // CALLING must never be auto-requeued.
    expect(call.where.status.in).toEqual([ProcessingStatus.PENDING, ProcessingStatus.PROCESSING]);
    expect(call.where.status.in).not.toContain(ProcessingStatus.CALLING);
  });

  it('returns false when the lead is in a state it will not requeue', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });

    expect(await requeueForRetry('id-1', 4, 'uncertain call result')).toBe(false);
  });
});

describe('sanitizeErrorMessage', () => {
  it('strips credentials out of connection strings', () => {
    const result = sanitizeErrorMessage(
      new Error('failed: postgresql://admin:hunter2@db.internal:5432/prod'),
    );

    expect(result).not.toContain('hunter2');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts key-like values', () => {
    expect(sanitizeErrorMessage('request failed api_key=sk_live_abc123')).not.toContain(
      'sk_live_abc123',
    );
  });

  it('collapses multi-line messages to one line', () => {
    expect(sanitizeErrorMessage('line one\n  line two')).toBe('line one line two');
  });

  it('truncates to the column limit', () => {
    const result = sanitizeErrorMessage('x'.repeat(2000));

    expect(result.length).toBe(500);
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles non-Error values', () => {
    expect(sanitizeErrorMessage(undefined)).toBe('Unknown error');
    expect(sanitizeErrorMessage('plain string')).toBe('plain string');
  });
});
