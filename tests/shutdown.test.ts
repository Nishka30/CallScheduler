import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from '../src/lib/shutdown.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

function deps(overrides: Partial<Parameters<typeof createShutdownHandler>[0]> = {}) {
  return {
    closeServer: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    exit: vi.fn(),
    ...overrides,
  };
}

describe('graceful shutdown', () => {
  it('closes the HTTP server, then the database client, then exits 0', async () => {
    const order: string[] = [];
    const d = deps({
      closeServer: vi.fn(() => {
        order.push('server');
        return Promise.resolve();
      }),
      disconnect: vi.fn(() => {
        order.push('database');
        return Promise.resolve();
      }),
    });

    await createShutdownHandler(d)('SIGTERM');

    // The server must stop accepting requests before the pool goes away.
    expect(order).toEqual(['server', 'database']);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it('stops the lead worker FIRST, before closing the server and database', async () => {
    const order: string[] = [];
    const d = deps({
      stopWorker: vi.fn(() => {
        order.push('worker');
        return Promise.resolve();
      }),
      closeServer: vi.fn(() => {
        order.push('server');
        return Promise.resolve();
      }),
      disconnect: vi.fn(() => {
        order.push('database');
        return Promise.resolve();
      }),
    });

    await createShutdownHandler(d)('SIGTERM');

    expect(order).toEqual(['worker', 'server', 'database']);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it('does not fail shutdown when stopping the worker throws', async () => {
    const d = deps({ stopWorker: vi.fn().mockRejectedValue(new Error('worker stuck')) });

    await createShutdownHandler(d)('SIGTERM');

    // Worker teardown is best-effort; server/db still close and exit stays 0.
    expect(d.closeServer).toHaveBeenCalledTimes(1);
    expect(d.disconnect).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent across repeated signals', async () => {
    const d = deps();
    const shutdown = createShutdownHandler(d);

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')]);

    expect(d.closeServer).toHaveBeenCalledTimes(1);
    expect(d.disconnect).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it('still disconnects the database when closing the server fails', async () => {
    const d = deps({ closeServer: vi.fn().mockRejectedValue(new Error('close failed')) });

    await createShutdownHandler(d)('SIGTERM');

    expect(d.disconnect).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('exits non-zero when the database client fails to disconnect', async () => {
    const d = deps({ disconnect: vi.fn().mockRejectedValue(new Error('pool stuck')) });

    await createShutdownHandler(d)('SIGTERM');

    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('forces an exit when shutdown exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ closeServer: vi.fn(() => new Promise<void>(() => {})) });

      void createShutdownHandler({ ...d, timeoutMs: 1_000 })('SIGTERM');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(d.exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not force an exit when shutdown completes in time', async () => {
    vi.useFakeTimers();
    try {
      const d = deps();

      await createShutdownHandler({ ...d, timeoutMs: 1_000 })('SIGTERM');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(d.exit).toHaveBeenCalledTimes(1);
      expect(d.exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
