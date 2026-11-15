import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import type { CallerStatusClient } from '../src/integrations/guidedBoost/callerStatus.client.js';
import type { DueDeadlineLead } from '../src/repositories/leadProcessing.repository.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

// Repo is referenced only as default deps; tests inject their own.
vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  findActiveQueueCallsNearDeadline: vi.fn(),
  claimCallInProgressSend: vi.fn(),
  resetCallInProgressSend: vi.fn(),
  updateCallBeforeAt: vi.fn(),
}));

const { DeadlineMonitorSweeper, buildDeadlineMonitorSweeper } = await import(
  '../src/services/deadlineMonitor.service.js'
);

function config(over: Record<string, string> = {}) {
  return parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', LEAD_API_KEY_CALLER: 'k', ...over });
}

const CFG = { leadMs: 60_000, maxPerCycle: 20, batchSize: 100 };
const DEADLINE = new Date('2026-11-15T09:10:00.000Z');

function lead(over: Partial<DueDeadlineLead> = {}): DueDeadlineLead {
  return { leadId: 'lead-1', callBeforeAt: DEADLINE, ...over };
}

function fakeClient(result: {
  outcome: 'extended' | 'not_extended' | 'conflict' | 'failed';
  callBefore?: Date;
}) {
  return { reportCallInProgress: vi.fn().mockResolvedValue(result) } as unknown as CallerStatusClient;
}

function sweeper(
  overrides: Partial<Parameters<typeof makeDeps>[0]> = {},
  cfg = CFG,
): InstanceType<typeof DeadlineMonitorSweeper> {
  return new DeadlineMonitorSweeper(cfg, makeDeps(overrides));
}

function makeDeps(o: {
  findDue?: ReturnType<typeof vi.fn>;
  claim?: ReturnType<typeof vi.fn>;
  releaseClaim?: ReturnType<typeof vi.fn>;
  persistDeadline?: ReturnType<typeof vi.fn>;
  statusClient?: CallerStatusClient;
} = {}) {
  return {
    findDue: o.findDue ?? vi.fn().mockResolvedValue([]),
    claim: o.claim ?? vi.fn().mockResolvedValue(true),
    releaseClaim: o.releaseClaim ?? vi.fn().mockResolvedValue(undefined),
    persistDeadline: o.persistDeadline ?? vi.fn().mockResolvedValue(undefined),
    statusClient: o.statusClient ?? fakeClient({ outcome: 'not_extended' }),
    now: () => new Date('2026-11-15T09:09:30.000Z').getTime(),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('DeadlineMonitorSweeper', () => {
  it('sends call_in_progress for a due active QUEUE call and claims once', async () => {
    const client = fakeClient({ outcome: 'not_extended' });
    const claim = vi.fn().mockResolvedValue(true);
    const s = sweeper({ findDue: vi.fn().mockResolvedValue([lead()]), claim, statusClient: client });

    const summary = await s.runSweep();

    expect(claim).toHaveBeenCalledWith('lead-1', expect.any(Date));
    expect(client.reportCallInProgress).toHaveBeenCalledWith('lead-1');
    expect(summary.notExtended).toBe(1);
  });

  it('nothing due → no report', async () => {
    const client = fakeClient({ outcome: 'not_extended' });
    const s = sweeper({ findDue: vi.fn().mockResolvedValue([]), statusClient: client });

    const summary = await s.runSweep();

    expect(summary.considered).toBe(0);
    expect(client.reportCallInProgress).not.toHaveBeenCalled();
  });

  it('passes the lead window + batch size to the due query (threshold check)', async () => {
    const findDue = vi.fn().mockResolvedValue([]);
    await sweeper({ findDue }).runSweep();
    expect(findDue).toHaveBeenCalledWith(expect.any(Date), 60_000, 100);
  });

  it('lost claim (concurrency / already-sent / terminal) → does not send', async () => {
    const client = fakeClient({ outcome: 'extended', callBefore: DEADLINE });
    const s = sweeper({
      findDue: vi.fn().mockResolvedValue([lead()]),
      claim: vi.fn().mockResolvedValue(false),
      statusClient: client,
    });

    const summary = await s.runSweep();

    expect(summary.skippedClaim).toBe(1);
    expect(client.reportCallInProgress).not.toHaveBeenCalled();
  });

  it('extension granted → persists the GB-returned call_before (never now+10m)', async () => {
    const newDeadline = new Date('2026-11-15T09:20:00.000Z');
    const persistDeadline = vi.fn().mockResolvedValue(undefined);
    const s = sweeper({
      findDue: vi.fn().mockResolvedValue([lead()]),
      persistDeadline,
      statusClient: fakeClient({ outcome: 'extended', callBefore: newDeadline }),
    });

    const summary = await s.runSweep();

    expect(summary.extended).toBe(1);
    expect(persistDeadline).toHaveBeenCalledWith('lead-1', newDeadline);
  });

  it('no-extension response preserves the deadline (no persist, claim kept)', async () => {
    const persistDeadline = vi.fn();
    const releaseClaim = vi.fn();
    const s = sweeper({
      findDue: vi.fn().mockResolvedValue([lead()]),
      persistDeadline,
      releaseClaim,
      statusClient: fakeClient({ outcome: 'not_extended', callBefore: DEADLINE }),
    });

    await s.runSweep();

    expect(persistDeadline).not.toHaveBeenCalled();
    expect(releaseClaim).not.toHaveBeenCalled(); // once-only guard stays set
  });

  it('409 conflict → no persist, no release (final stays authoritative)', async () => {
    const persistDeadline = vi.fn();
    const releaseClaim = vi.fn();
    const s = sweeper({
      findDue: vi.fn().mockResolvedValue([lead()]),
      persistDeadline,
      releaseClaim,
      statusClient: fakeClient({ outcome: 'conflict' }),
    });

    const summary = await s.runSweep();

    expect(summary.conflict).toBe(1);
    expect(persistDeadline).not.toHaveBeenCalled();
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it('send failure → releases the claim (recoverable), never persists a deadline', async () => {
    const persistDeadline = vi.fn();
    const releaseClaim = vi.fn().mockResolvedValue(undefined);
    const s = sweeper({
      findDue: vi.fn().mockResolvedValue([lead()]),
      persistDeadline,
      releaseClaim,
      statusClient: fakeClient({ outcome: 'failed' }),
    });

    const summary = await s.runSweep();

    expect(summary.failed).toBe(1);
    expect(releaseClaim).toHaveBeenCalledWith('lead-1');
    expect(persistDeadline).not.toHaveBeenCalled();
  });

  it('honors maxPerCycle', async () => {
    const client = fakeClient({ outcome: 'not_extended' });
    const s = sweeper(
      { findDue: vi.fn().mockResolvedValue([lead({ leadId: 'a' }), lead({ leadId: 'b' })]), statusClient: client },
      { ...CFG, maxPerCycle: 1 },
    );

    await s.runSweep();

    expect(client.reportCallInProgress).toHaveBeenCalledTimes(1);
  });
});

describe('buildDeadlineMonitorSweeper — feature flag', () => {
  it('returns null when CALLER_DEADLINE_MONITOR_ENABLED is false (default)', () => {
    expect(buildDeadlineMonitorSweeper(config())).toBeNull();
  });

  it('builds a sweeper when enabled', () => {
    expect(
      buildDeadlineMonitorSweeper(config({ CALLER_DEADLINE_MONITOR_ENABLED: 'true' })),
    ).toBeInstanceOf(DeadlineMonitorSweeper);
  });
});
