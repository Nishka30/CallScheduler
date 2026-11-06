import type { CallRecord } from '@prisma/client';
import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { findNotesForRedelivery } from '../repositories/callRecord.repository.js';
import { deliverCallNote, type NoteDeliveryResult } from './callNoteDelivery.service.js';

/**
 * Reconciliation sweep that RE-DELIVERS CRM call notes that failed the first time.
 *
 * Without this, a transient CRM failure set `noteStatus='failed'` and the note was
 * never retried — the call record existed but the CRM never got its note. This sweep
 * reuses `deliverCallNote` (single-shot, `noteStatus==='sent'`-guarded, never throws),
 * so it cannot duplicate a note; `findNotesForRedelivery` bounds it by an attempt cap
 * and a backoff, so a permanently-failing note is left `failed` rather than looping.
 */

export interface NoteReconcileConfig {
  maxAttempts: number;
  backoffMs: number;
  maxPerCycle: number;
  batchSize: number;
}

export interface NoteReconcileSummary {
  considered: number;
  delivered: number;
  failed: number;
  alreadySent: number;
  errors: number;
}

export interface NoteReconcileDeps {
  findDue?: (
    now: Date,
    maxAttempts: number,
    backoffMs: number,
    limit: number,
  ) => Promise<CallRecord[]>;
  deliver?: (record: CallRecord) => Promise<NoteDeliveryResult>;
  now?: () => number;
}

export class NoteReconciliationSweeper {
  private readonly config: NoteReconcileConfig;
  private readonly findDue: NonNullable<NoteReconcileDeps['findDue']>;
  private readonly deliver: NonNullable<NoteReconcileDeps['deliver']>;
  private readonly now: () => number;

  constructor(config: NoteReconcileConfig, deps: NoteReconcileDeps = {}) {
    this.config = config;
    this.findDue = deps.findDue ?? findNotesForRedelivery;
    this.deliver = deps.deliver ?? ((record) => deliverCallNote(record));
    this.now = deps.now ?? (() => Date.now());
  }

  async runSweep(): Promise<NoteReconcileSummary> {
    const summary: NoteReconcileSummary = {
      considered: 0,
      delivered: 0,
      failed: 0,
      alreadySent: 0,
      errors: 0,
    };

    const due = await this.findDue(
      new Date(this.now()),
      this.config.maxAttempts,
      this.config.backoffMs,
      this.config.batchSize,
    );
    summary.considered = due.length;

    let processed = 0;
    for (const record of due) {
      if (processed >= this.config.maxPerCycle) break;
      processed += 1;
      try {
        const result = await this.deliver(record);
        if (result === 'sent') summary.delivered += 1;
        else if (result === 'already_sent') summary.alreadySent += 1;
        else summary.failed += 1;
      } catch (error) {
        summary.errors += 1;
        logger.warn(
          { callRecordId: record.id, err: error instanceof Error ? error.name : 'unknown' },
          'note reconciliation: delivery raised unexpectedly; will retry next sweep',
        );
      }
    }

    logger.info(summary, 'CRM note reconciliation sweep complete');
    return summary;
  }
}

/** Builds the note-reconciliation sweeper from config, or null when disabled. */
export function buildNoteReconciliationSweeper(
  config: Env = env,
): NoteReconciliationSweeper | null {
  if (!config.LEAD_RECONCILE_ENABLED) return null;
  return new NoteReconciliationSweeper({
    maxAttempts: config.LEAD_NOTE_RETRY_MAX_ATTEMPTS,
    backoffMs: config.LEAD_NOTE_RETRY_BACKOFF_MS,
    maxPerCycle: config.LEAD_RECONCILE_MAX_PER_CYCLE,
    batchSize: config.LEAD_RECONCILE_BATCH_SIZE,
  });
}
