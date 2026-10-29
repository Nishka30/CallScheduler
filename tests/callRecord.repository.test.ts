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
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
};

const txQueryRaw = vi.fn();

const prismaMock = {
  callRecord,
  // Run the callback inline against the same mocked delegate; the tx also
  // exposes $queryRaw for the FOR UPDATE row lock.
  $transaction: vi.fn((callback: (tx: unknown) => unknown) =>
    callback({ callRecord, $queryRaw: txQueryRaw }),
  ),
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
  computeSafeCallUpdate,
  applyWebhookCallEvent,
  listCallRecords,
  getCallRecordDetail,
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

describe('computeSafeCallUpdate (pure terminal-safe merge)', () => {
  const base = {
    status: CallStatus.IN_PROGRESS,
    outcome: null,
    summary: null,
    startedAt: null,
    endedAt: null,
    transcript: null,
    transcriptJson: null,
    analysis: null,
    recordingUrl: null,
    disconnectionReason: null,
    direction: null,
    customerTz: null,
    agentId: null,
    agentVersion: null,
    transcriptWithToolCalls: null,
    recordingMultiChannelUrl: null,
    publicLogUrl: null,
    providerMetadata: null,
  };

  it('advances a non-terminal status forward', () => {
    const data = computeSafeCallUpdate(
      { ...base, status: CallStatus.INITIATED },
      { status: CallStatus.IN_PROGRESS },
    );
    expect(data.status).toBe(CallStatus.IN_PROGRESS);
  });

  it('never downgrades a terminal status (call_ended then a late call_started)', () => {
    const data = computeSafeCallUpdate(
      { ...base, status: CallStatus.COMPLETED },
      { status: CallStatus.IN_PROGRESS },
    );
    expect(data.status).toBeUndefined();
  });

  it('never lets one terminal status overwrite another (first terminal wins)', () => {
    const data = computeSafeCallUpdate(
      { ...base, status: CallStatus.COMPLETED },
      { status: CallStatus.FAILED },
    );
    expect(data.status).toBeUndefined();
  });

  it('never overwrites a known status with UNKNOWN', () => {
    const data = computeSafeCallUpdate(
      { ...base, status: CallStatus.IN_PROGRESS },
      { status: CallStatus.UNKNOWN },
    );
    expect(data.status).toBeUndefined();
  });

  it('upgrades outcome from null/UNKNOWN to a known value', () => {
    expect(
      computeSafeCallUpdate(base, { status: CallStatus.COMPLETED, outcome: CallOutcome.VOICEMAIL })
        .outcome,
    ).toBe(CallOutcome.VOICEMAIL);
    expect(
      computeSafeCallUpdate(
        { ...base, outcome: CallOutcome.UNKNOWN },
        { status: CallStatus.COMPLETED, outcome: CallOutcome.VOICEMAIL },
      ).outcome,
    ).toBe(CallOutcome.VOICEMAIL);
  });

  it('never overwrites a known outcome, and never writes UNKNOWN over it', () => {
    const existing = { ...base, outcome: CallOutcome.APPOINTMENT_BOOKED };
    expect(
      computeSafeCallUpdate(existing, {
        status: CallStatus.COMPLETED,
        outcome: CallOutcome.VOICEMAIL,
      }).outcome,
    ).toBeUndefined();
    expect(
      computeSafeCallUpdate(existing, {
        status: CallStatus.COMPLETED,
        outcome: CallOutcome.UNKNOWN,
      }).outcome,
    ).toBeUndefined();
  });

  it('fills summary and timestamps once, then never clobbers them', () => {
    const filled = computeSafeCallUpdate(base, {
      status: CallStatus.COMPLETED,
      summary: 'short summary',
      startedAt: new Date('2026-10-15T10:00:00Z'),
      endedAt: new Date('2026-10-15T10:05:00Z'),
    });
    expect(filled.summary).toBe('short summary');
    expect(filled.startedAt).toEqual(new Date('2026-10-15T10:00:00Z'));

    const already = {
      ...base,
      summary: 'original',
      startedAt: new Date('2026-10-15T09:00:00Z'),
      endedAt: new Date('2026-10-15T09:05:00Z'),
    };
    const second = computeSafeCallUpdate(already, {
      status: CallStatus.COMPLETED,
      summary: 'a different, later summary',
      startedAt: new Date('2026-10-15T11:00:00Z'),
      endedAt: new Date('2026-10-15T11:05:00Z'),
    });
    expect(second.summary).toBeUndefined();
    expect(second.startedAt).toBeUndefined();
    expect(second.endedAt).toBeUndefined();
  });

  it('truncates an over-long summary to the column limit', () => {
    const data = computeSafeCallUpdate(base, {
      status: CallStatus.COMPLETED,
      summary: 'x'.repeat(5000),
    });
    expect((data.summary as string).length).toBe(2000);
  });

  it('returns an empty patch when nothing may safely change', () => {
    const existing = {
      ...base,
      status: CallStatus.COMPLETED,
      outcome: CallOutcome.VOICEMAIL,
      summary: 'done',
      startedAt: new Date(),
      endedAt: new Date(),
    };
    expect(computeSafeCallUpdate(existing, { status: CallStatus.IN_PROGRESS })).toEqual({});
  });
});

describe('applyWebhookCallEvent', () => {
  it('returns matched:false for an unknown provider call id (never fabricates)', async () => {
    callRecord.findUnique.mockResolvedValue(null);

    const result = await applyWebhookCallEvent('call-unknown', { status: CallStatus.COMPLETED });

    expect(result).toEqual({ matched: false, changed: false });
    expect(callRecord.update).not.toHaveBeenCalled();
  });

  it('locks the row, applies a safe change, and reports changed', async () => {
    callRecord.findUnique.mockResolvedValue(row({ status: CallStatus.IN_PROGRESS }));
    callRecord.update.mockResolvedValue(row({ status: CallStatus.COMPLETED }));

    const result = await applyWebhookCallEvent('call-abc', { status: CallStatus.COMPLETED });

    expect(txQueryRaw).toHaveBeenCalled(); // FOR UPDATE lock
    expect(result.matched).toBe(true);
    expect(result.changed).toBe(true);
  });

  it('is a no-op (changed:false) when the merge yields nothing to change', async () => {
    callRecord.findUnique.mockResolvedValue(row({ status: CallStatus.COMPLETED }));

    const result = await applyWebhookCallEvent('call-abc', { status: CallStatus.IN_PROGRESS });

    expect(result.matched).toBe(true);
    expect(result.changed).toBe(false);
    expect(callRecord.update).not.toHaveBeenCalled();
  });
});

describe('listCallRecords (read API)', () => {
  it('applies filters, orders newest-first, and sets nextCursor when a further page exists', async () => {
    // limit 2 → fetch 3; a 3rd row means there is a next page.
    callRecord.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);

    const page = await listCallRecords(
      { leadId: 'lead-1', status: CallStatus.COMPLETED },
      { limit: 2 },
    );

    expect(page.items.map((i) => i.id)).toEqual(['c1', 'c2']);
    expect(page.nextCursor).toBe('c2');
    const arg = callRecord.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      take: number;
      select: Record<string, unknown>;
    };
    expect(arg.where).toMatchObject({ leadId: 'lead-1', status: CallStatus.COMPLETED });
    expect(arg.take).toBe(3);
    // The list projection must NOT include heavy/sensitive fields.
    expect(arg.select).not.toHaveProperty('transcript');
    expect(arg.select).not.toHaveProperty('analysis');
    expect(arg.select).not.toHaveProperty('providerMetadata');
  });

  it('returns a null cursor on the last page', async () => {
    callRecord.findMany.mockResolvedValue([{ id: 'c1' }]);
    const page = await listCallRecords({}, { limit: 25 });
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
  });
});

describe('getCallRecordDetail (read API)', () => {
  it('looks up by internal UUID', async () => {
    callRecord.findUnique.mockResolvedValue(row({ id: 'aa000000-0000-4000-8000-000000000001' }));
    const r = await getCallRecordDetail('aa000000-0000-4000-8000-000000000001');
    expect(r).not.toBeNull();
    expect(callRecord.findUnique).toHaveBeenCalledWith({
      where: { id: 'aa000000-0000-4000-8000-000000000001' },
    });
  });

  it('falls back to the Retell call id for a non-UUID lookup', async () => {
    callRecord.findUnique.mockResolvedValue(row({ retellCallId: 'call_abc' }));
    const r = await getCallRecordDetail('call_abc');
    expect(r).not.toBeNull();
    expect(callRecord.findUnique).toHaveBeenCalledWith({ where: { retellCallId: 'call_abc' } });
  });

  it('returns null when nothing matches', async () => {
    callRecord.findUnique.mockResolvedValue(null);
    expect(await getCallRecordDetail('call_missing')).toBeNull();
  });
});
