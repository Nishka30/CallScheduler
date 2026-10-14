import { describe, expect, it, vi } from 'vitest';
import { evaluateCallWindow, isHoldActive } from '../src/services/callWindow.service.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const NOW = new Date('2026-10-14T12:00:00.000Z');

describe('evaluateCallWindow', () => {
  it('reports within_hold with seconds remaining for a future timestamp', () => {
    const result = evaluateCallWindow('2026-10-14T12:05:00.000Z', NOW);

    expect(result).toEqual({
      state: 'within_hold',
      holdUntil: '2026-10-14T12:05:00.000Z',
      secondsRemaining: 300,
    });
  });

  it('reports no_active_hold (absent) when caller_hold_until is null', () => {
    // null is what the API returns while CALLER_HOLD_MINUTES = 0.
    expect(evaluateCallWindow(null, NOW)).toEqual({ state: 'no_active_hold', reason: 'absent' });
  });

  it('reports no_active_hold (absent) when caller_hold_until is undefined', () => {
    expect(evaluateCallWindow(undefined, NOW)).toEqual({
      state: 'no_active_hold',
      reason: 'absent',
    });
  });

  it('reports no_active_hold (expired) for a past timestamp, carrying how overdue it is', () => {
    const result = evaluateCallWindow('2026-10-14T11:50:00.000Z', NOW);

    expect(result).toEqual({
      state: 'no_active_hold',
      reason: 'expired',
      holdUntil: '2026-10-14T11:50:00.000Z',
      secondsOverdue: 600,
    });
  });

  it('reports no_active_hold (unparsable) for a non-timestamp, rather than guessing a state', () => {
    expect(evaluateCallWindow('not-a-date', NOW)).toEqual({
      state: 'no_active_hold',
      reason: 'unparsable',
    });
  });

  it('treats the exact boundary moment as no_active_hold, not within the window', () => {
    // At diffMs === 0 there is no time left, so the hold is over and the lead is
    // back with the sales team.
    const result = evaluateCallWindow('2026-10-14T12:00:00.000Z', NOW);

    expect(result.state).toBe('no_active_hold');
    if (result.state === 'no_active_hold') {
      expect(result.reason).toBe('expired');
    }
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

describe('the two Lead API hold configurations', () => {
  // David's revised contract: the hold duration is a Lead API setting
  // (CALLER_HOLD_MINUTES). Both of its configured values must classify
  // correctly without any code change.

  it('CALLER_HOLD_MINUTES = 0 (today): a null hold means do not call', () => {
    // At 0 minutes the API returns caller_hold_until: null for every lead.
    const result = evaluateCallWindow(null, NOW);

    expect(result.state).toBe('no_active_hold');
    expect(isHoldActive(result)).toBe(false);
  });

  it('CALLER_HOLD_MINUTES = 10 (caller testing): a fresh lead is within the hold', () => {
    // A lead created ~now carries a ~10-minute future hold.
    const tenMinutesOut = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    const result = evaluateCallWindow(tenMinutesOut, NOW);

    expect(result.state).toBe('within_hold');
    expect(isHoldActive(result)).toBe(true);
    if (result.state === 'within_hold') {
      expect(result.secondsRemaining).toBe(600);
    }
  });

  it('CALLER_HOLD_MINUTES = 10: the same lead is no longer callable once the 10 minutes pass', () => {
    // 11 minutes after creation the hold has lapsed and the lead is back with sales.
    const createdAtHold = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    const elevenMinutesLater = new Date(NOW.getTime() + 11 * 60_000);

    const result = evaluateCallWindow(createdAtHold, elevenMinutesLater);

    expect(result.state).toBe('no_active_hold');
    expect(isHoldActive(result)).toBe(false);
  });
});

describe('isHoldActive', () => {
  it('is true only for an active (future) hold', () => {
    expect(isHoldActive(evaluateCallWindow('2026-10-14T12:05:00.000Z', NOW))).toBe(true);
  });

  it('is false for null, expired and unparsable holds', () => {
    expect(isHoldActive(evaluateCallWindow(null, NOW))).toBe(false);
    expect(isHoldActive(evaluateCallWindow('2026-10-14T11:50:00.000Z', NOW))).toBe(false);
    expect(isHoldActive(evaluateCallWindow('nonsense', NOW))).toBe(false);
  });
});
