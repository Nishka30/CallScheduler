import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, CallStatus, CallOutcome } from '@prisma/client';

/**
 * Prisma is fully mocked: these tests assert the duplicate-prevention *contract*
 * of the repository (what it asks the database to do) without requiring a
 * database - the same approach as leadProcessing.repository.test.ts.
 */
const callRecord = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
};

const prismaMock = {
  callRecord,
  // Run the callback inline against the same mocked delegate.
  $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({ callRecord })),
};

vi.mock('../src/lib/prisma.js', () => ({
  prisma: prismaMock,
  disconnectPrisma: vi.fn(),
}));

const {
  recordCallAttempt,
  findActiveCallAttempt,
  hasActiveCallAttempt,
  countCallAttempts,
  attachProviderCallId,
  recordCallResult,
} = await import('../src/repositories/callRecord.repository.js');

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'aa000000-0000-4000-8000-000000000001',
    leadId: 'lead-1',
    personKey: null,
    retellCallId: null,
    status: CallStatus.PENDING,
    outcome: null,
    summary: null,
    startedAt: null,
    endedAt: null,
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

const UNRESOLVED = [
  CallStatus.PENDING,
  CallStatus.INITIATED,
  CallStatus.IN_PROGRESS,
  CallStatus.UNKNOWN,
];

beforeEach(() => {
  Object.values(callRecord).forEach((fn) => fn.mockReset());
  prismaMock.$transaction.mockClear();
});

describe('recordCallAttempt', () => {
  it('creates the first attempt for a lead inside a transaction', async () => {
    const created = row();
    callRecord.findFirst.mockResolvedValue(null);
    callRecord.create.mockResolvedValue(created);

    const result = await recordCallAttempt({ leadId: 'lead-1' });

    expect(result).toEqual({ created: true, record: created });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(callRecord.create).toHaveBeenCalledWith({
      data: { leadId: 'lead-1', status: CallStatus.PENDING },
    });
  });

  it('carries a personKey through when provided', async () => {
    callRecord.findFirst.mockResolvedValue(null);
    callRecord.create.mockResolvedValue(row({ personKey: 'person-9' }));

    await recordCallAttempt({ leadId: 'lead-1', personKey: 'person-9' });

    expect(callRecord.create).toHaveBeenCalledWith({
      data: { leadId: 'lead-1', personKey: 'person-9', status: CallStatus.PENDING },
    });
  });

  it('does NOT open a second attempt while one is still unresolved', async () => {
    const inFlight = row({ status: CallStatus.IN_PROGRESS });
    callRecord.findFirst.mockResolvedValue(inFlight);

    const result = await recordCallAttempt({ leadId: 'lead-1' });

    // This is the duplicate-call guard: an in-flight attempt blocks a second dial.
    expect(result).toEqual({ created: false, record: inFlight });
    expect(callRecord.create).not.toHaveBeenCalled();
  });

  it('only counts unresolved statuses as blocking a new attempt', async () => {
    callRecord.findFirst.mockResolvedValue(null);
    callRecord.create.mockResolvedValue(row());

    await recordCallAttempt({ leadId: 'lead-1' });

    const where = callRecord.findFirst.mock.calls[0]![0] as {
      where: { leadId: string; status: { in: string[] } };
    };
    expect(where.where.leadId).toBe('lead-1');
    expect(where.where.status.in).toEqual(UNRESOLVED);
    // Terminal states must not be here, or a lead could never be retried.
    expect(where.where.status.in).not.toContain(CallStatus.COMPLETED);
    expect(where.where.status.in).not.toContain(CallStatus.FAILED);
  });

  it('resolves a unique-constraint race to the existing attempt (once the index is applied)', async () => {
    const winner = row({ status: CallStatus.INITIATED });
    // Inside the transaction nothing is seen, so an insert is attempted...
    callRecord.findFirst.mockResolvedValueOnce(null);
    callRecord.create.mockRejectedValue(uniqueConstraintError());
    // ...then the post-catch read finds the row the winning caller created.
    callRecord.findFirst.mockResolvedValueOnce(winner);

    const result = await recordCallAttempt({ leadId: 'lead-1' });

    expect(result).toEqual({ created: false, record: winner });
  });

  it('lets exactly one of two concurrent callers create the attempt', async () => {
    const created = row();
    // First caller: nothing in flight, insert succeeds.
    // Second caller: nothing in flight at check time, insert hits the unique
    // index, then reads back the first caller's row.
    callRecord.findFirst
      .mockResolvedValueOnce(null) // caller A check
      .mockResolvedValueOnce(null) // caller B check
      .mockResolvedValueOnce(created); // caller B post-catch read
    callRecord.create.mockResolvedValueOnce(created).mockRejectedValueOnce(uniqueConstraintError());

    const [a, b] = await Promise.all([
      recordCallAttempt({ leadId: 'lead-1' }),
      recordCallAttempt({ leadId: 'lead-1' }),
    ]);

    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it('propagates errors that are not unique-constraint violations', async () => {
    callRecord.findFirst.mockResolvedValue(null);
    callRecord.create.mockRejectedValue(new Error('connection lost'));

    await expect(recordCallAttempt({ leadId: 'lead-1' })).rejects.toThrow('connection lost');
  });
});

describe('findActiveCallAttempt / hasActiveCallAttempt', () => {
  it('returns the unresolved attempt when one exists', async () => {
    const inFlight = row({ status: CallStatus.INITIATED });
    callRecord.findFirst.mockResolvedValue(inFlight);

    expect(await findActiveCallAttempt('lead-1')).toEqual(inFlight);
    expect(await hasActiveCallAttempt('lead-1')).toBe(true);
  });

  it('reports no active attempt when none is in flight', async () => {
    callRecord.findFirst.mockResolvedValue(null);

    expect(await findActiveCallAttempt('lead-1')).toBeNull();
    expect(await hasActiveCallAttempt('lead-1')).toBe(false);
  });
});

describe('countCallAttempts', () => {
  it('counts every attempt for a lead regardless of status', async () => {
    callRecord.count.mockResolvedValue(3);

    expect(await countCallAttempts('lead-1')).toBe(3);
    expect(callRecord.count).toHaveBeenCalledWith({ where: { leadId: 'lead-1' } });
  });
});

describe('attachProviderCallId', () => {
  it('stamps the provider id and moves PENDING -> INITIATED, only when unset', async () => {
    const now = new Date('2026-04-01T08:00:00.000Z');
    const attached = row({
      status: CallStatus.INITIATED,
      retellCallId: 'call-abc',
      startedAt: now,
    });
    callRecord.updateMany.mockResolvedValue({ count: 1 });
    callRecord.findUniqueOrThrow.mockResolvedValue(attached);

    const result = await attachProviderCallId('rec-1', 'call-abc', now);

    expect(result).toEqual(attached);
    expect(callRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'rec-1', retellCallId: null },
      data: { retellCallId: 'call-abc', status: CallStatus.INITIATED, startedAt: now },
    });
  });

  it('is idempotent when re-attaching the same provider id', async () => {
    // Nothing updated (already attached), but the stored id matches -> no throw.
    const attached = row({ status: CallStatus.INITIATED, retellCallId: 'call-abc' });
    callRecord.updateMany.mockResolvedValue({ count: 0 });
    callRecord.findUniqueOrThrow.mockResolvedValue(attached);

    const result = await attachProviderCallId('rec-1', 'call-abc');

    expect(result).toEqual(attached);
  });

  it('refuses to re-link an attempt to a different provider id', async () => {
    const attached = row({ status: CallStatus.INITIATED, retellCallId: 'call-abc' });
    callRecord.updateMany.mockResolvedValue({ count: 0 });
    callRecord.findUniqueOrThrow.mockResolvedValue(attached);

    await expect(attachProviderCallId('rec-1', 'call-DIFFERENT')).rejects.toThrow(
      /different provider call id/,
    );
  });
});

describe('recordCallResult', () => {
  it('returns null for an unknown provider id, rather than creating a row', async () => {
    callRecord.findUnique.mockResolvedValue(null);

    const result = await recordCallResult('call-unknown', { status: CallStatus.COMPLETED });

    expect(result).toBeNull();
    expect(callRecord.update).not.toHaveBeenCalled();
  });

  it('applies the terminal status, outcome and summary keyed by provider id', async () => {
    const existing = row({ status: CallStatus.IN_PROGRESS, retellCallId: 'call-abc' });
    const endedAt = new Date('2026-04-01T08:05:00.000Z');
    const updated = row({
      status: CallStatus.COMPLETED,
      outcome: CallOutcome.APPOINTMENT_BOOKED,
      retellCallId: 'call-abc',
      endedAt,
    });
    callRecord.findUnique.mockResolvedValue(existing);
    callRecord.update.mockResolvedValue(updated);

    const result = await recordCallResult('call-abc', {
      status: CallStatus.COMPLETED,
      outcome: CallOutcome.APPOINTMENT_BOOKED,
      summary: 'Booked a consultation.',
      endedAt,
    });

    expect(result).toEqual(updated);
    expect(callRecord.update).toHaveBeenCalledWith({
      where: { retellCallId: 'call-abc' },
      data: {
        status: CallStatus.COMPLETED,
        outcome: CallOutcome.APPOINTMENT_BOOKED,
        summary: 'Booked a consultation.',
        endedAt,
      },
    });
  });

  it('truncates an over-long summary to the column limit', async () => {
    callRecord.findUnique.mockResolvedValue(row({ retellCallId: 'call-abc' }));
    callRecord.update.mockResolvedValue(row({ retellCallId: 'call-abc' }));

    await recordCallResult('call-abc', {
      status: CallStatus.COMPLETED,
      summary: 'x'.repeat(5000),
    });

    const data = callRecord.update.mock.calls[0]![0] as { data: { summary: string } };
    expect(data.data.summary.length).toBe(2000);
  });
});
