import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  createReviewNoteIntent,
  findReviewNotesForDelivery,
  findNeedsReviewWithoutNote,
  claimReviewNoteDelivery,
  markReviewNoteSent,
  markReviewNoteFailed,
  type DueReviewNote,
} from '../repositories/leadProcessing.repository.js';
import {
  notifyNeedsReviewToCrm,
  NEEDS_REVIEW_NOTIFY_REASONS,
  type NeedsReviewNoteResult,
} from './needsReviewNotification.service.js';

/**
 * Reliable CRM review-note delivery.
 *
 * `enqueueReviewNote` records a PERSISTENT delivery intent on the lead (de-duplicated
 * per lead+reason) whenever a lead enters NEEDS_REVIEW for a notifiable reason, when a
 * no-answer retry has been waiting too long for a hold (`retry_hold_unavailable`), or
 * when a stuck call is reconciled (`call_unreconciled`). The `ReviewNoteSweeper` then
 * delivers pending/failed intents with a per-attempt claim, bounded attempts and
 * backoff — so a transient CRM failure or a worker restart never loses the note.
 *
 * NOTE ON DELIVERY SEMANTICS: the CRM notes API has no confirmed idempotency, so this
 * is AT-LEAST-ONCE with strong duplicate MINIMISATION (a per-attempt CAS claim), not
 * exactly-once. The unavoidable gap — the CRM accepts the note but the process dies
 * before `markReviewNoteSent` — can produce one duplicate note on the next sweep.
 */

/** Records a review-note intent for a notifiable reason. Returns false if filtered/duplicate. */
export async function enqueueReviewNote(
  leadId: string,
  reason: string,
  detail?: string,
): Promise<boolean> {
  if (!(NEEDS_REVIEW_NOTIFY_REASONS as readonly string[]).includes(reason)) {
    return false; // not a notifiable reason (e.g. awaiting_new_lead_rule_confirmation)
  }
  return createReviewNoteIntent(leadId, reason, detail);
}

export interface ReviewNoteSweepConfig {
  maxAttempts: number;
  backoffMs: number;
  leaseMs: number;
  maxPerCycle: number;
  batchSize: number;
}

export interface ReviewNoteSweepSummary {
  considered: number;
  delivered: number;
  failed: number;
  skipped: number;
  races: number;
  errors: number;
}

export interface ReviewNoteSweeperDeps {
  findDue?: (now: Date, maxAttempts: number, limit: number) => Promise<DueReviewNote[]>;
  findMissing?: (
    reasons: readonly string[],
    limit: number,
  ) => Promise<Array<{ leadId: string; decisionReason: string | null; decisionDetail: string | null }>>;
  createIntent?: (leadId: string, reason: string, detail: string | undefined) => Promise<boolean>;
  claim?: (leadId: string, expectedAttempts: number, leaseUntil: Date) => Promise<boolean>;
  deliver?: (leadId: string, reason: string, detail?: string) => Promise<NeedsReviewNoteResult>;
  markSent?: (leadId: string, now: Date) => Promise<void>;
  markFailed?: (leadId: string, error: string, nextAttemptAt: Date) => Promise<void>;
  now?: () => number;
}

export class ReviewNoteSweeper {
  private readonly config: ReviewNoteSweepConfig;
  private readonly findDue: NonNullable<ReviewNoteSweeperDeps['findDue']>;
  private readonly findMissing: NonNullable<ReviewNoteSweeperDeps['findMissing']>;
  private readonly createIntent: NonNullable<ReviewNoteSweeperDeps['createIntent']>;
  private readonly claim: NonNullable<ReviewNoteSweeperDeps['claim']>;
  private readonly deliver: NonNullable<ReviewNoteSweeperDeps['deliver']>;
  private readonly markSent: NonNullable<ReviewNoteSweeperDeps['markSent']>;
  private readonly markFailed: NonNullable<ReviewNoteSweeperDeps['markFailed']>;
  private readonly now: () => number;

  constructor(config: ReviewNoteSweepConfig, deps: ReviewNoteSweeperDeps = {}) {
    this.config = config;
    this.findDue = deps.findDue ?? findReviewNotesForDelivery;
    this.findMissing = deps.findMissing ?? findNeedsReviewWithoutNote;
    this.createIntent = deps.createIntent ?? createReviewNoteIntent;
    this.claim = deps.claim ?? claimReviewNoteDelivery;
    this.deliver =
      deps.deliver ?? ((leadId, reason, detail) => notifyNeedsReviewToCrm(leadId, reason, detail));
    this.markSent = deps.markSent ?? markReviewNoteSent;
    this.markFailed = deps.markFailed ?? markReviewNoteFailed;
    this.now = deps.now ?? (() => Date.now());
  }

  async runSweep(): Promise<ReviewNoteSweepSummary> {
    const summary: ReviewNoteSweepSummary = {
      considered: 0,
      delivered: 0,
      failed: 0,
      skipped: 0,
      races: 0,
      errors: 0,
    };
    const nowMs = this.now();

    // Backfill: any NEEDS_REVIEW lead whose notifiable reason never got an intent
    // (e.g. the one-time enqueue write failed) gets one now, so a review note can
    // never be silently missed. createReviewNoteIntent is idempotent/de-duplicated.
    try {
      const missing = await this.findMissing(NEEDS_REVIEW_NOTIFY_REASONS, this.config.batchSize);
      for (const row of missing.slice(0, this.config.maxPerCycle)) {
        if (row.decisionReason) {
          await this.createIntent(row.leadId, row.decisionReason, row.decisionDetail ?? undefined);
        }
      }
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.name : 'unknown' },
        'review-note sweep: backfill of missing intents failed (delivery phase continues)',
      );
    }

    const due = await this.findDue(new Date(nowMs), this.config.maxAttempts, this.config.batchSize);
    summary.considered = due.length;

    let processed = 0;
    for (const row of due) {
      if (processed >= this.config.maxPerCycle) break;
      processed += 1;

      // Claim so concurrent sweeps do not both post the same note.
      const claimed = await this.claim(
        row.leadId,
        row.reviewNoteAttempts,
        new Date(nowMs + this.config.leaseMs),
      );
      if (!claimed) {
        summary.races += 1;
        continue;
      }

      const reason = row.reviewNoteReason ?? '';
      const detail = row.reviewNoteDetail ?? undefined;
      try {
        const result = await this.deliver(row.leadId, reason, detail);
        if (result === 'sent') {
          await this.markSent(row.leadId, new Date(nowMs));
          summary.delivered += 1;
        } else if (result === 'skipped') {
          // Nothing to send (reason no longer notifiable) — done, do not loop.
          await this.markSent(row.leadId, new Date(nowMs));
          summary.skipped += 1;
        } else {
          await this.markFailed(
            row.leadId,
            'crm review-note delivery failed',
            new Date(nowMs + this.config.backoffMs),
          );
          summary.failed += 1;
        }
      } catch (error) {
        summary.errors += 1;
        await this.markFailed(
          row.leadId,
          error instanceof Error ? error.name : 'unknown',
          new Date(nowMs + this.config.backoffMs),
        );
        logger.warn(
          { leadId: row.leadId, err: error instanceof Error ? error.name : 'unknown' },
          'review-note sweep: delivery raised unexpectedly; marked failed for retry',
        );
      }
    }

    logger.info(summary, 'CRM review-note delivery sweep complete');
    return summary;
  }
}

/** Builds the review-note sweeper (always on when the worker runs; delivery is safe). */
export function buildReviewNoteSweeper(config: Env = env): ReviewNoteSweeper {
  return new ReviewNoteSweeper({
    maxAttempts: config.LEAD_NOTE_RETRY_MAX_ATTEMPTS,
    backoffMs: config.LEAD_NOTE_RETRY_BACKOFF_MS,
    leaseMs: Math.min(config.LEAD_NOTE_RETRY_BACKOFF_MS, 120_000),
    maxPerCycle: config.LEAD_RECONCILE_MAX_PER_CYCLE,
    batchSize: config.LEAD_RECONCILE_BATCH_SIZE,
  });
}
