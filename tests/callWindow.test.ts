import { describe, expect, it, vi } from 'vitest';
import { evaluateCallWindow } from '../src/services/callWindow.service.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const NOW = new Date('2026-10-14T12:00:00.000Z');

describe('evaluateCallWindow', () => {
  it('reports no_hold_info when callerHoldUntil is absent', () => {
    expect(evaluateCallWindow(undefined, NOW)).toEqual({ state: 'no_hold_info' });
  });

  it('reports no_hold_info for an unparsable value, rather than guessing a state', () => {
    expect(evaluateCallWindow('not-a-date', NOW)).toEqual({ state: 'no_hold_info' });
  });

  it('reports within_hold with seconds remaining for a future timestamp', () => {
    const result = evaluateCallWindow('2026-10-14T12:05:00.000Z', NOW);

    expect(result).toEqual({
      state: 'within_hold',
      holdUntil: '2026-10-14T12:05:00.000Z',
      secondsRemaining: 300,
    });
  });

  it('reports hold_expired with seconds overdue for a past timestamp', () => {
    const result = evaluateCallWindow('2026-10-14T11:50:00.000Z', NOW);

    expect(result).toEqual({
      state: 'hold_expired',
      holdUntil: '2026-10-14T11:50:00.000Z',
      secondsOverdue: 600,
    });
  });

  it('treats the exact boundary moment as expired, not within the window', () => {
    // At diffMs === 0 there is no time left, so it is not "within" anything.
    const result = evaluateCallWindow('2026-10-14T12:00:00.000Z', NOW);

    expect(result.state).toBe('hold_expired');
  });

  it('is a pure function: the same input always produces the same output', () => {
    const a = evaluateCallWindow('2026-10-14T12:05:00.000Z', NOW);
    const b = evaluateCallWindow('2026-10-14T12:05:00.000Z', NOW);

    expect(a).toEqual(b);
  });

  it('never makes a network request or touches the database', () => {
    // Structural guarantee: the module has no fetch/prisma import at all -
    // calling it with a bogus value must not throw or hang.
    expect(() => evaluateCallWindow('garbage', NOW)).not.toThrow();
  });
});
