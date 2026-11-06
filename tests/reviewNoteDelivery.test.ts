import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReviewNoteSweeper,
  type ReviewNoteSweepConfig,
} from '../src/services/reviewNoteDelivery.service.js';

const NOW = new Date('2026-11-01T12:00:00.000Z').getTime();

function cfg(overrides: Partial<ReviewNoteSweepConfig> = {}): ReviewNoteSweepConfig {
  return { maxAttempts: 5, backoffMs: 300_000, leaseMs: 120_000, maxPerCycle: 10, batchSize: 50, ...overrides };
}

let findDue: ReturnType<typeof vi.fn>;
let claim: ReturnType<typeof vi.fn>;
let deliver: ReturnType<typeof vi.fn>;
let markSent: ReturnType<typeof vi.fn>;
let markFailed: ReturnType<typeof vi.fn>;
let findMissing: ReturnType<typeof vi.fn>;
let createIntent: ReturnType<typeof vi.fn>;

function sweeper(config = cfg()) {
  return new ReviewNoteSweeper(config, {
    findDue,
    findMissing,
    createIntent,
    claim,
    deliver,
    markSent,
    markFailed,
    now: () => NOW,
  });
}

const note = (o: Record<string, unknown> = {}) => ({
  leadId: 'l1',
  reviewNoteReason: 'phone_verdict_unreadable',
  reviewNoteDetail: 'keys: x',
  reviewNoteAttempts: 0,
  ...o,
});

beforeEach(() => {
  findDue = vi.fn().mockResolvedValue([]);
  findMissing = vi.fn().mockResolvedValue([]);
  createIntent = vi.fn().mockResolvedValue(true);
  claim = vi.fn().mockResolvedValue(true);
  deliver = vi.fn().mockResolvedValue('sent');
  markSent = vi.fn().mockResolvedValue(undefined);
  markFailed = vi.fn().mockResolvedValue(undefined);
});

describe('ReviewNoteSweeper', () => {
  it('claims, delivers and marks a due note sent', async () => {
    findDue.mockResolvedValue([note()]);

    const summary = await sweeper().runSweep();

    expect(claim).toHaveBeenCalledWith('l1', 0, new Date(NOW + 120_000));
    expect(deliver).toHaveBeenCalledWith('l1', 'phone_verdict_unreadable', 'keys: x');
    expect(markSent).toHaveBeenCalledWith('l1', new Date(NOW));
    expect(summary.delivered).toBe(1);
  });

  it('does not deliver when the claim is lost to another worker (no duplicate note)', async () => {
    findDue.mockResolvedValue([note()]);
    claim.mockResolvedValue(false);

    const summary = await sweeper().runSweep();

    expect(deliver).not.toHaveBeenCalled();
    expect(summary.races).toBe(1);
  });

  it('marks failed with a backoff when the CRM delivery fails', async () => {
    findDue.mockResolvedValue([note()]);
    deliver.mockResolvedValue('failed');

    const summary = await sweeper().runSweep();

    expect(markFailed).toHaveBeenCalledWith('l1', expect.any(String), new Date(NOW + 300_000));
    expect(summary.failed).toBe(1);
  });

  it('treats a non-notifiable reason as done (skipped -> sent, no endless retry)', async () => {
    findDue.mockResolvedValue([note()]);
    deliver.mockResolvedValue('skipped');

    const summary = await sweeper().runSweep();

    expect(markSent).toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it('a deliver throw is contained and the note is marked failed for retry', async () => {
    findDue.mockResolvedValue([note()]);
    deliver.mockRejectedValue(new Error('boom'));

    const summary = await sweeper().runSweep();

    expect(summary.errors).toBe(1);
    expect(markFailed).toHaveBeenCalled();
  });

  it('respects the per-cycle cap', async () => {
    findDue.mockResolvedValue([note({ leadId: 'a' }), note({ leadId: 'b' }), note({ leadId: 'c' })]);
    await sweeper(cfg({ maxPerCycle: 2 })).runSweep();
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('backfills an intent for a NEEDS_REVIEW lead whose one-time enqueue was missed', async () => {
    findMissing.mockResolvedValue([
      { leadId: 'l9', decisionReason: 'person_key_absent', decisionDetail: 'no key' },
    ]);

    await sweeper().runSweep();

    expect(createIntent).toHaveBeenCalledWith('l9', 'person_key_absent', 'no key');
  });
});
