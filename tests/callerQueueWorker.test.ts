import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CallerQueueWorker,
  startCallerQueueWorker,
  stopCallerQueueWorker,
} from '../src/services/callerQueueWorker.service.js';
import type { CallerQueuePollSummary } from '../src/services/callerQueue.service.js';
import type { Env } from '../src/config/env.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

// The worker's default poll step is runCallerQueuePoll; mock the whole service so
// the singleton tests never touch the network or database.
const runCallerQueuePoll = vi.fn<() => Promise<CallerQueuePollSummary>>();
vi.mock('../src/services/callerQueue.service.js', () => ({
  runCallerQueuePoll: () => runCallerQueuePoll(),
}));

/** A hand-driven scheduler so tests advance cycles deterministically. */
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
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }
  return { setTimer, clearTimer, tick, hasPending: () => pending !== null };
}

afterEach(async () => {
  await stopCallerQueueWorker();
  runCallerQueuePoll.mockReset();
});

describe('CallerQueueWorker', () => {
  it('runs a poll cycle on start and reschedules the next', async () => {
    const sched = controllableScheduler();
    const runPoll = vi.fn(() =>
      Promise.resolve({ enabled: true, fetched: false } as CallerQueuePollSummary),
    );
    const w = new CallerQueueWorker({ intervalMs: 30000, maxBackoffMs: 300000, runPoll, ...sched });

    w.start();
    expect(w.getStatus().running).toBe(true);
    await sched.tick();

    expect(runPoll).toHaveBeenCalledTimes(1);
    expect(w.getStatus().cyclesCompleted).toBe(1);
    expect(sched.hasPending()).toBe(true); // next cycle scheduled
  });

  it('drives repeated polls; the same offer returning again is a service no-op (duplicate)', async () => {
    const sched = controllableScheduler();
    // First cycle: a lead is prepared+dialled. Second cycle: the same offer comes
    // back and the service reports it as a duplicate (no second call). The worker
    // itself simply re-invokes the idempotent poll — it never duplicates.
    const runPoll = vi
      .fn<() => Promise<CallerQueuePollSummary>>()
      .mockResolvedValueOnce({
        enabled: true,
        fetched: true,
        outcome: 'prepared',
        callOutcome: 'call_initiated',
        leadId: 'lead-1',
      })
      .mockResolvedValueOnce({
        enabled: true,
        fetched: true,
        outcome: 'duplicate',
        leadId: 'lead-1',
      });
    const w = new CallerQueueWorker({ intervalMs: 30000, maxBackoffMs: 300000, runPoll, ...sched });

    w.start();
    await sched.tick();
    await sched.tick();

    expect(runPoll).toHaveBeenCalledTimes(2);
    expect(w.getStatus().lastSummary?.outcome).toBe('duplicate');
  });

  it('a failing cycle does not kill the loop (backs off and reschedules)', async () => {
    const sched = controllableScheduler();
    const runPoll = vi
      .fn<() => Promise<CallerQueuePollSummary>>()
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValue({ enabled: true, fetched: false });
    const w = new CallerQueueWorker({ intervalMs: 30000, maxBackoffMs: 300000, runPoll, ...sched });

    w.start();
    await sched.tick();

    expect(w.getStatus().lastPollOk).toBe(false);
    expect(w.getStatus().consecutiveErrors).toBe(1);
    expect(sched.hasPending()).toBe(true); // loop survived
  });

  it('startCallerQueueWorker returns null when disabled', () => {
    const disabled = { CALLER_QUEUE_ENABLED: false } as Env;
    expect(startCallerQueueWorker(disabled)).toBeNull();
  });
});
