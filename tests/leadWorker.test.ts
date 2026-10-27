import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LeadWorker,
  startLeadWorker,
  stopLeadWorker,
  getLeadWorkerStatus,
} from '../src/services/leadWorker.service.js';
import type { PollSummary } from '../src/services/leadPolling.service.js';
import type { Env } from '../src/config/env.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $transaction: vi.fn(), $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

// The worker's default poll step is runLeadPoll; mock it so the singleton tests
// never touch the network or database.
const runLeadPoll = vi.fn<() => Promise<PollSummary>>();
vi.mock('../src/services/leadPolling.service.js', () => ({
  runLeadPoll: () => runLeadPoll(),
}));

function summary(over: Partial<PollSummary> = {}): PollSummary {
  return {
    pagesFetched: 1,
    rowsSeen: 3,
    decisionsApplied: 2,
    alreadyDecided: 1,
    byOutcome: {},
    callsConsidered: 0,
    callOutcomes: {},
    bootstrap: false,
    finalCursor: null,
    warnings: [],
    ...over,
  };
}

/** A hand-driven scheduler: captures the next callback so tests advance time. */
function controllableScheduler() {
  let pending: (() => void) | null = null;
  const setTimer = (fn: () => void) => {
    pending = fn;
    return 0 as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = () => {
    pending = null;
  };
  async function tick(): Promise<void> {
    const fn = pending;
    pending = null;
    if (fn) fn();
    // Let the async cycle (and its .finally reschedule) settle.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }
  return { setTimer, clearTimer, tick, hasPending: () => pending !== null };
}

afterEach(async () => {
  await stopLeadWorker();
  runLeadPoll.mockReset();
});

describe('LeadWorker — scheduling', () => {
  it('runs a poll cycle on start and records a safe summary', async () => {
    const sched = controllableScheduler();
    const runPoll = vi.fn(() => Promise.resolve(summary({ rowsSeen: 7, callsConsidered: 1 })));
    const w = new LeadWorker({ intervalMs: 1000, maxBackoffMs: 60000, runPoll, ...sched });

    w.start();
    expect(w.getStatus().running).toBe(true);
    await sched.tick();

    expect(runPoll).toHaveBeenCalledTimes(1);
    const s = w.getStatus();
    expect(s.cyclesCompleted).toBe(1);
    expect(s.lastPollOk).toBe(true);
    expect(s.lastSummary).toMatchObject({ rowsSeen: 7, callsConsidered: 1 });
    await w.stop();
  });

  it('reschedules and runs repeated cycles at the interval', async () => {
    const sched = controllableScheduler();
    const runPoll = vi.fn(() => Promise.resolve(summary()));
    const w = new LeadWorker({ intervalMs: 1000, maxBackoffMs: 60000, runPoll, ...sched });
    w.start();
    await sched.tick();
    await sched.tick();
    await sched.tick();
    expect(runPoll).toHaveBeenCalledTimes(3);
    await w.stop();
  });

  it('never overlaps cycles: a slow poll blocks the next from starting', async () => {
    const sched = controllableScheduler();
    let release!: (s: PollSummary) => void;
    const slow = new Promise<PollSummary>((r) => {
      release = r;
    });
    const runPoll = vi.fn(() => slow);
    const w = new LeadWorker({ intervalMs: 1000, maxBackoffMs: 60000, runPoll, ...sched });

    w.start();
    await sched.tick(); // starts cycle 1, which is now pending (unresolved)
    expect(runPoll).toHaveBeenCalledTimes(1);
    expect(w.getStatus().polling).toBe(true);
    // No next timer is scheduled while the cycle is in flight.
    expect(sched.hasPending()).toBe(false);

    release(summary());
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(w.getStatus().polling).toBe(false);
    await w.stop();
  });
});

describe('LeadWorker — failure handling', () => {
  it('isolates a failing cycle, records a sanitised error, and keeps looping with backoff', async () => {
    const sched = controllableScheduler();
    const runPoll = vi
      .fn<() => Promise<PollSummary>>()
      .mockRejectedValueOnce(new Error('boom: postgres://user:secret@host failed'))
      .mockResolvedValue(summary());
    const w = new LeadWorker({ intervalMs: 1000, maxBackoffMs: 60000, runPoll, ...sched });

    w.start();
    await sched.tick(); // cycle 1 fails
    let s = w.getStatus();
    expect(s.consecutiveErrors).toBe(1);
    expect(s.lastPollOk).toBe(false);
    expect(s.lastError).toBeDefined();
    expect(s.lastError).not.toContain('secret'); // credentials stripped
    expect(sched.hasPending()).toBe(true); // loop continues

    await sched.tick(); // cycle 2 succeeds → error count resets
    s = w.getStatus();
    expect(s.consecutiveErrors).toBe(0);
    expect(s.lastPollOk).toBe(true);
    await w.stop();
  });

  it('treats a skipped cycle (lock not acquired) as success, not an error', async () => {
    const sched = controllableScheduler();
    const runPoll = vi.fn(() => Promise.resolve(summary()));
    // withLock returns undefined → cycle skipped (another replica polling).
    const withLock = vi.fn(() => Promise.resolve(undefined));
    const w = new LeadWorker({
      intervalMs: 1000,
      maxBackoffMs: 60000,
      runPoll,
      withLock,
      ...sched,
    });

    w.start();
    await sched.tick();
    expect(runPoll).not.toHaveBeenCalled(); // lock gated the poll
    const s = w.getStatus();
    expect(s.consecutiveErrors).toBe(0);
    expect(s.lastPollOk).toBe(true);
    await w.stop();
  });
});

describe('LeadWorker — lifecycle', () => {
  it('stop() halts scheduling and awaits the in-flight cycle', async () => {
    const sched = controllableScheduler();
    const runPoll = vi.fn(() => Promise.resolve(summary()));
    const w = new LeadWorker({ intervalMs: 1000, maxBackoffMs: 60000, runPoll, ...sched });
    w.start();
    await sched.tick();
    await w.stop();
    expect(w.getStatus().running).toBe(false);
    // No further cycles after stop even if a stray timer fires.
    await sched.tick();
    expect(runPoll).toHaveBeenCalledTimes(1);
  });
});

describe('LeadWorker — re-evaluation sweep hook', () => {
  it('runs the sweep after a successful poll', async () => {
    const sched = controllableScheduler();
    const order: string[] = [];
    const runPoll = vi.fn(() => {
      order.push('poll');
      return Promise.resolve(summary());
    });
    const runSweep = vi.fn(() => {
      order.push('sweep');
      return Promise.resolve();
    });
    const w = new LeadWorker({
      intervalMs: 1000,
      maxBackoffMs: 60000,
      runPoll,
      runSweep,
      ...sched,
    });

    w.start();
    await sched.tick();

    expect(order).toEqual(['poll', 'sweep']);
    await w.stop();
  });

  it('does NOT run the sweep when the poll was skipped (lock not acquired)', async () => {
    const sched = controllableScheduler();
    const runPoll = vi.fn(() => Promise.resolve(summary()));
    const runSweep = vi.fn(() => Promise.resolve());
    const w = new LeadWorker({
      intervalMs: 1000,
      maxBackoffMs: 60000,
      runPoll,
      runSweep,
      withLock: () => Promise.resolve(undefined), // lock gated the whole cycle
      ...sched,
    });

    w.start();
    await sched.tick();

    expect(runPoll).not.toHaveBeenCalled();
    expect(runSweep).not.toHaveBeenCalled();
    await w.stop();
  });

  it('a failing sweep never fails the poll cycle or triggers backoff', async () => {
    const sched = controllableScheduler();
    const runPoll = vi.fn(() => Promise.resolve(summary()));
    const runSweep = vi.fn(() => Promise.reject(new Error('sweep boom')));
    const w = new LeadWorker({
      intervalMs: 1000,
      maxBackoffMs: 60000,
      runPoll,
      runSweep,
      ...sched,
    });

    w.start();
    await sched.tick();

    const s = w.getStatus();
    expect(s.lastPollOk).toBe(true); // poll stays green despite sweep failure
    expect(s.consecutiveErrors).toBe(0);
    expect(s.cyclesCompleted).toBe(1);
    await w.stop();
  });
});

describe('startLeadWorker / getLeadWorkerStatus', () => {
  it('does not start when LEAD_WORKER_ENABLED is false', () => {
    const w = startLeadWorker({
      LEAD_WORKER_ENABLED: false,
      LEAD_WORKER_INTERVAL_MS: 60000,
      LEAD_WORKER_MAX_BACKOFF_MS: 300000,
      LEAD_WORKER_USE_DB_LOCK: false,
    } as unknown as Env);
    expect(w).toBeNull();
    expect(getLeadWorkerStatus().running).toBe(false);
  });

  it('starts and reports running when enabled, and stops cleanly', async () => {
    runLeadPoll.mockResolvedValue(summary());
    const w = startLeadWorker({
      LEAD_WORKER_ENABLED: true,
      LEAD_WORKER_INTERVAL_MS: 60000,
      LEAD_WORKER_MAX_BACKOFF_MS: 300000,
      LEAD_WORKER_USE_DB_LOCK: false,
    } as unknown as Env);
    expect(w).not.toBeNull();
    expect(getLeadWorkerStatus().running).toBe(true);
    await stopLeadWorker();
    expect(getLeadWorkerStatus().running).toBe(false);
  });
});
