import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NoteReconciliationSweeper,
  type NoteReconcileConfig,
} from '../src/services/noteReconciliation.service.js';

const NOW = new Date('2026-09-01T12:00:00.000Z').getTime();

function cfg(overrides: Partial<NoteReconcileConfig> = {}): NoteReconcileConfig {
  return { maxAttempts: 5, backoffMs: 300_000, maxPerCycle: 10, batchSize: 50, ...overrides };
}

let findDue: ReturnType<typeof vi.fn>;
let deliver: ReturnType<typeof vi.fn>;

function sweeper(config = cfg()) {
  return new NoteReconciliationSweeper(config, { findDue, deliver, now: () => NOW });
}

beforeEach(() => {
  findDue = vi.fn().mockResolvedValue([]);
  deliver = vi.fn().mockResolvedValue('sent');
});

describe('NoteReconciliationSweeper', () => {
  it('delivers each due note and tallies the result', async () => {
    findDue.mockResolvedValue([{ id: 'c1', leadId: 'l1' }, { id: 'c2', leadId: 'l2' }]);

    const summary = await sweeper().runSweep();

    expect(findDue).toHaveBeenCalledWith(new Date(NOW), 5, 300_000, 50);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(summary.delivered).toBe(2);
  });

  it('counts failures and already-sent separately and never throws on a single failure', async () => {
    findDue.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);
    deliver
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('already_sent')
      .mockResolvedValueOnce('sent');

    const summary = await sweeper().runSweep();

    expect(summary.failed).toBe(1);
    expect(summary.alreadySent).toBe(1);
    expect(summary.delivered).toBe(1);
  });

  it('a deliver throw is contained (does not abort the sweep)', async () => {
    findDue.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    deliver.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('sent');

    const summary = await sweeper().runSweep();

    expect(summary.errors).toBe(1);
    expect(summary.delivered).toBe(1);
  });

  it('respects the per-cycle cap', async () => {
    findDue.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);

    await sweeper(cfg({ maxPerCycle: 2 })).runSweep();

    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
