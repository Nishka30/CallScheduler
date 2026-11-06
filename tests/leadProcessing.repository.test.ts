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
  findMany: vi.fn(),
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
  completeCallingLead,
  ensureProcessingRecord,
  finalizeRejectedEligibleLead,
  scheduleRetryOrComplete,
  findDueRetries,
  beginRetryAttempt,
  finalizeHoldExpired,
  reschedulePendingRetry,
  findStuckCalling,
  findStuckProcessing,
  findEligibleNotCalled,
  reconcileStuckCalling,
  requeueStuckProcessing,
  completeReconciledCall,
  createReviewNoteIntent,
  findReviewNotesForDelivery,
  claimReviewNoteDelivery,
  markReviewNoteSent,
  markReviewNoteFailed,
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

describe('completeCallingLead', () => {
  it('transitions a CALLING lead to COMPLETED and releases the claim (status-guarded, no version)', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const ok = await completeCallingLead('lead-1');

    expect(ok).toBe(true);
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Matches ONLY a CALLING lead, so a late/duplicate event can't touch a newer state.
    expect(call.where).toEqual({ leadId: 'lead-1', status: ProcessingStatus.CALLING });
    expect(call.data.status).toBe(ProcessingStatus.COMPLETED);
    expect(call.data.version).toEqual({ increment: 1 });
    expect(call.data.claimedAt).toBeNull();
    expect(call.data.claimedBy).toBeNull();
  });

  it('returns false (safe no-op) when the lead is not CALLING — duplicate/late event or newer attempt', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });

    expect(await completeCallingLead('lead-1')).toBe(false);
  });
});

describe('finalizeRejectedEligibleLead', () => {
  it('moves an ELIGIBLE lead to a terminal state with a status-guarded CAS, keeping reason + detail', async () => {
    const now = new Date('2026-04-01T08:00:00.000Z');
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const ok = await finalizeRejectedEligibleLead(
      'lead-1',
      ProcessingStatus.SKIPPED,
      'hold_expired',
      'caller hold is not active',
      now,
    );

    expect(ok).toBe(true);
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Matches ONLY an ELIGIBLE lead, so a lead another worker already claimed
    // (ELIGIBLE -> PROCESSING) is never clobbered mid-call.
    expect(call.where).toEqual({ leadId: 'lead-1', status: ProcessingStatus.ELIGIBLE });
    expect(call.data.status).toBe(ProcessingStatus.SKIPPED);
    expect(call.data.version).toEqual({ increment: 1 });
    expect(call.data.decisionReason).toBe('hold_expired');
    expect(call.data.decisionDetail).toBe('caller hold is not active');
    expect(call.data.decidedAt).toBe(now);
  });

  it('returns false (safe no-op) when the lead is no longer ELIGIBLE', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });

    expect(
      await finalizeRejectedEligibleLead('lead-1', ProcessingStatus.SKIPPED, 'already_assigned'),
    ).toBe(false);
  });

  it('can route a data-gap rejection to NEEDS_REVIEW so the sweep can retry it', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    await finalizeRejectedEligibleLead('lead-1', ProcessingStatus.NEEDS_REVIEW, 'phone_verdict_unreadable');

    const call = leadProcessing.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.status).toBe(ProcessingStatus.NEEDS_REVIEW);
    expect(call.data.decisionDetail).toBeNull();
  });

  it('sanitizes the detail so a credential can never be persisted', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    await finalizeRejectedEligibleLead(
      'lead-1',
      ProcessingStatus.SKIPPED,
      'crm_route_excluded',
      'failed at postgresql://admin:hunter2@db.internal:5432/prod',
    );

    const call = leadProcessing.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.decisionDetail).not.toContain('hunter2');
  });
});

describe('scheduleRetryOrComplete (no-answer webhook)', () => {
  const NEXT = new Date('2026-05-01T10:05:00.000Z');
  const NOW = new Date('2026-05-01T10:00:00.000Z');

  it('schedules a retry (CALLING -> RETRY_PENDING, nextRetryAt set) when under the attempt cap', async () => {
    leadProcessing.findUnique.mockResolvedValue(
      record({ status: ProcessingStatus.CALLING, attemptCount: 1 }),
    );
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const result = await scheduleRetryOrComplete('lead-1', NEXT, 5, NOW);

    expect(result).toBe('scheduled');
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({ status: ProcessingStatus.CALLING, version: 3 });
    expect(call.data.status).toBe(ProcessingStatus.RETRY_PENDING);
    expect(call.data.nextRetryAt).toBe(NEXT);
  });

  it('completes the lead when the attempt cap is reached (no 6th call)', async () => {
    leadProcessing.findUnique.mockResolvedValue(
      record({ status: ProcessingStatus.CALLING, attemptCount: 5 }),
    );
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const result = await scheduleRetryOrComplete('lead-1', NEXT, 5, NOW);

    expect(result).toBe('completed');
    const call = leadProcessing.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.status).toBe(ProcessingStatus.COMPLETED);
    expect(call.data.nextRetryAt).toBeNull();
  });

  it('is a no-op when the lead is not CALLING (duplicate/late event)', async () => {
    leadProcessing.findUnique.mockResolvedValue(record({ status: ProcessingStatus.COMPLETED }));

    expect(await scheduleRetryOrComplete('lead-1', NEXT, 5, NOW)).toBe('noop');
    expect(leadProcessing.updateMany).not.toHaveBeenCalled();
  });
});

describe('findDueRetries', () => {
  it('queries RETRY_PENDING leads that are due and under the attempt cap, oldest first', async () => {
    leadProcessing.findMany.mockResolvedValue([]);
    const now = new Date('2026-05-01T12:00:00.000Z');

    await findDueRetries(now, 5, 10);

    const call = leadProcessing.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
      take: number;
    };
    expect(call.where).toMatchObject({
      status: ProcessingStatus.RETRY_PENDING,
      nextRetryAt: { lte: now },
      attemptCount: { lt: 5 },
    });
    expect(call.orderBy).toEqual({ nextRetryAt: 'asc' });
    expect(call.take).toBe(10);
  });
});

describe('beginRetryAttempt', () => {
  it('moves RETRY_PENDING -> ELIGIBLE with a version-guarded CAS and clears nextRetryAt', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const ok = await beginRetryAttempt('id-1', 4);

    expect(ok).toBe(true);
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: 'id-1', version: 4, status: ProcessingStatus.RETRY_PENDING });
    expect(call.data.status).toBe(ProcessingStatus.ELIGIBLE);
    expect(call.data.nextRetryAt).toBeNull();
  });

  it('returns false when another worker already began the retry', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });
    expect(await beginRetryAttempt('id-1', 4)).toBe(false);
  });
});

describe('finalizeHoldExpired', () => {
  const NEXT = new Date('2026-05-01T10:05:00.000Z');
  const NOW = new Date('2026-05-01T10:00:00.000Z');

  it('reschedules a RETRY (prior attempts, under cap) back to RETRY_PENDING instead of skipping', async () => {
    leadProcessing.findUnique.mockResolvedValue(
      record({ status: ProcessingStatus.ELIGIBLE, attemptCount: 2 }),
    );
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const result = await finalizeHoldExpired('lead-1', NEXT, 5, NOW);

    expect(result).toBe('rescheduled');
    const call = leadProcessing.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.status).toBe(ProcessingStatus.RETRY_PENDING);
    expect(call.data.nextRetryAt).toBe(NEXT);
    expect(call.data.decisionReason).toBe('hold_expired');
  });

  it('skips a FIRST-attempt lead (attemptCount 0) whose hold expired (unchanged behavior)', async () => {
    leadProcessing.findUnique.mockResolvedValue(
      record({ status: ProcessingStatus.ELIGIBLE, attemptCount: 0 }),
    );
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const result = await finalizeHoldExpired('lead-1', NEXT, 5, NOW);

    expect(result).toBe('skipped');
    const call = leadProcessing.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.status).toBe(ProcessingStatus.SKIPPED);
    expect(call.data.nextRetryAt).toBeNull();
  });

  it('is a no-op when the lead is no longer ELIGIBLE', async () => {
    leadProcessing.findUnique.mockResolvedValue(record({ status: ProcessingStatus.PROCESSING }));
    expect(await finalizeHoldExpired('lead-1', NEXT, 5, NOW)).toBe('noop');
    expect(leadProcessing.updateMany).not.toHaveBeenCalled();
  });
});

describe('reconciliation queries', () => {
  it('findStuckCalling selects CALLING leads whose last activity is older than the cutoff', async () => {
    leadProcessing.findMany.mockResolvedValue([]);
    const cutoff = new Date('2026-07-01T12:00:00.000Z');

    await findStuckCalling(cutoff, 20);

    const call = leadProcessing.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(call.where).toMatchObject({
      status: ProcessingStatus.CALLING,
      lastAttemptAt: { lte: cutoff },
    });
    expect(call.take).toBe(20);
  });

  it('findStuckProcessing selects PROCESSING leads claimed before the cutoff', async () => {
    leadProcessing.findMany.mockResolvedValue([]);
    const cutoff = new Date('2026-07-01T12:00:00.000Z');

    await findStuckProcessing(cutoff, 20);

    const call = leadProcessing.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({
      status: ProcessingStatus.PROCESSING,
      claimedAt: { lte: cutoff },
    });
  });

  it('findEligibleNotCalled selects ELIGIBLE leads decided before the cutoff', async () => {
    leadProcessing.findMany.mockResolvedValue([]);
    const cutoff = new Date('2026-07-01T12:00:00.000Z');

    await findEligibleNotCalled(cutoff, 20);

    const call = leadProcessing.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({
      status: ProcessingStatus.ELIGIBLE,
      decidedAt: { lte: cutoff },
    });
  });
});

describe('review-note delivery state', () => {
  it('createReviewNoteIntent enqueues pending when none exists, or re-arms a sent note of a different reason', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    const now = new Date('2026-07-02T00:00:00.000Z');

    const ok = await createReviewNoteIntent('lead-1', 'phone_verdict_unreadable', 'keys: x', now);

    expect(ok).toBe(true);
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // De-dup: only when null, or sent for a DIFFERENT reason.
    expect(JSON.stringify(call.where)).toContain('reviewNoteStatus');
    expect(call.data.reviewNoteStatus).toBe('pending');
    expect(call.data.reviewNoteReason).toBe('phone_verdict_unreadable');
    expect(call.data.reviewNoteAttempts).toBe(0);
    expect(call.data.reviewNoteNextAttemptAt).toBe(now);
  });

  it('createReviewNoteIntent is a no-op (returns false) when an identical note is already in flight', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });
    expect(await createReviewNoteIntent('lead-1', 'person_key_absent', undefined)).toBe(false);
  });

  it('findReviewNotesForDelivery selects pending/failed notes under the cap and past the backoff', async () => {
    leadProcessing.findMany.mockResolvedValue([]);
    const now = new Date('2026-07-02T01:00:00.000Z');

    await findReviewNotesForDelivery(now, 5, 50);

    const call = leadProcessing.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(call.where).toMatchObject({
      reviewNoteStatus: { in: ['pending', 'failed'] },
      reviewNoteAttempts: { lt: 5 },
      reviewNoteNextAttemptAt: { lte: now },
    });
    expect(call.take).toBe(50);
  });

  it('claimReviewNoteDelivery is a CAS on the exact attempt count that leases the next attempt', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    const lease = new Date('2026-07-02T01:05:00.000Z');

    const ok = await claimReviewNoteDelivery('lead-1', 2, lease);

    expect(ok).toBe(true);
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({
      leadId: 'lead-1',
      reviewNoteStatus: { in: ['pending', 'failed'] },
      reviewNoteAttempts: 2,
    });
    expect(call.data.reviewNoteAttempts).toEqual({ increment: 1 });
    expect(call.data.reviewNoteNextAttemptAt).toBe(lease);
  });

  it('claimReviewNoteDelivery returns false when another worker already advanced the attempt', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });
    expect(await claimReviewNoteDelivery('lead-1', 2, new Date())).toBe(false);
  });

  it('markReviewNoteSent marks it sent and clears retry scheduling', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    const now = new Date('2026-07-02T02:00:00.000Z');

    await markReviewNoteSent('lead-1', now);

    const call = leadProcessing.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.reviewNoteStatus).toBe('sent');
    expect(call.data.reviewNoteSentAt).toBe(now);
    expect(call.data.reviewNoteNextAttemptAt).toBeNull();
  });

  it('markReviewNoteFailed records a sanitized error and the next attempt time', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });
    const next = new Date('2026-07-02T02:05:00.000Z');

    await markReviewNoteFailed('lead-1', 'crm 503', next);

    const call = leadProcessing.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.reviewNoteStatus).toBe('failed');
    expect(call.data.reviewNoteNextAttemptAt).toBe(next);
  });
});

describe('completeReconciledCall', () => {
  it('completes a NEEDS_REVIEW/call_unreconciled lead when its late terminal webhook arrives', async () => {
    const now = new Date('2026-07-03T00:00:00.000Z');
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const ok = await completeReconciledCall('lead-1', now);

    expect(ok).toBe(true);
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({
      leadId: 'lead-1',
      status: ProcessingStatus.NEEDS_REVIEW,
      decisionReason: 'call_unreconciled',
    });
    expect(call.data.status).toBe(ProcessingStatus.COMPLETED);
  });

  it('is a no-op for any other NEEDS_REVIEW lead', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });
    expect(await completeReconciledCall('lead-1', new Date())).toBe(false);
  });
});

describe('reconcileStuckCalling', () => {
  it('moves a stale CALLING lead to NEEDS_REVIEW (call_unreconciled) without claiming completion', async () => {
    const now = new Date('2026-07-01T13:00:00.000Z');
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const ok = await reconcileStuckCalling('id-1', 5, now);

    expect(ok).toBe(true);
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: 'id-1', version: 5, status: ProcessingStatus.CALLING });
    expect(call.data.status).toBe(ProcessingStatus.NEEDS_REVIEW);
    expect(call.data.decisionReason).toBe('call_unreconciled');
    expect(call.data.claimedAt).toBeNull();
  });

  it('is a safe no-op when the lead already left CALLING (late webhook won)', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });
    expect(await reconcileStuckCalling('id-1', 5, new Date())).toBe(false);
  });
});

describe('requeueStuckProcessing', () => {
  it('returns a stale PROCESSING lead to ELIGIBLE and un-counts the dial-less claim', async () => {
    const now = new Date('2026-07-01T13:00:00.000Z');
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const ok = await requeueStuckProcessing('id-1', 4, now);

    expect(ok).toBe(true);
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: 'id-1', version: 4, status: ProcessingStatus.PROCESSING });
    expect(call.data.status).toBe(ProcessingStatus.ELIGIBLE);
    expect(call.data.attemptCount).toEqual({ decrement: 1 });
    expect(call.data.claimedAt).toBeNull();
    expect(call.data.decidedAt).toBe(now);
  });

  it('is a safe no-op when the lead already advanced past PROCESSING', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });
    expect(await requeueStuckProcessing('id-1', 4, new Date())).toBe(false);
  });
});

describe('reschedulePendingRetry', () => {
  it('returns a stranded ELIGIBLE retry lead to RETRY_PENDING with a fresh nextRetryAt', async () => {
    const next = new Date('2026-05-01T10:05:00.000Z');
    leadProcessing.updateMany.mockResolvedValue({ count: 1 });

    const ok = await reschedulePendingRetry('lead-1', next);

    expect(ok).toBe(true);
    const call = leadProcessing.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ leadId: 'lead-1', status: ProcessingStatus.ELIGIBLE });
    expect(call.data.status).toBe(ProcessingStatus.RETRY_PENDING);
    expect(call.data.nextRetryAt).toBe(next);
  });

  it('is a safe no-op when the lead is no longer ELIGIBLE (dialled / terminal)', async () => {
    leadProcessing.updateMany.mockResolvedValue({ count: 0 });
    expect(await reschedulePendingRetry('lead-1', new Date())).toBe(false);
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
