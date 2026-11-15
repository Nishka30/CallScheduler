import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  findStatusReportsForRetry,
  claimStatusReportForRetry,
  type DueStatusReport,
} from '../repositories/leadProcessing.repository.js';
import { deliverQueueFinalStatus, type DeliverResult } from './guidedBoostStatus.service.js';

/**
 * Reconciliation sweep that RE-SENDS Guided Boost final-status reports that failed the
 * first time (`statusReportStatus = 'failed'`).
 *
 * STRICT INVARIANT: this ONLY repeats the HTTP status request. It never initiates a
 * call, never moves a lead to ELIGIBLE, never calls `initiateCallForLead`, never
 * touches the Step 5 source guards, and never re-derives the outcome — it re-sends the
 * already-persisted authoritative `lastFinalStatus`/`reason` (plus whatever artifacts
 * the CallRecord now holds) via the shared `deliverQueueFinalStatus`.
 *
 * Bounded by an attempt cap + backoff (`findStatusReportsForRetry`) and a per-lead CAS
 * lease so concurrent sweeps do not both post. After `maxAttempts` the report is left
 * `failed` (logged) rather than looping forever.
 */

export interface StatusReconcileConfig {
  maxAttempts: number;
  backoffMs: number;
  maxPerCycle: number;
  batchSize: number;
}

export interface StatusReconcileSummary {
  considered: number;
  sent: number;
  conflict: number;
  failed: number;
  invalid: number;
  skippedLease: number;
  errors: number;
}

export interface StatusReconcileDeps {
  findDue?: (now: Date, maxAttempts: number, limit: number) => Promise<DueStatusReport[]>;
  claim?: (leadId: string, now: Date, leaseUntil: Date) => Promise<boolean>;
  deliver?: (
    leadId: string,
    lastFinalStatus: string,
    reason: string | null,
  ) => Promise<DeliverResult>;
  now?: () => number;
}

export class StatusReconciliationSweeper {
  private readonly config: StatusReconcileConfig;
  private readonly findDue: NonNullable<StatusReconcileDeps['findDue']>;
  private readonly claim: NonNullable<StatusReconcileDeps['claim']>;
  private readonly deliver: NonNullable<StatusReconcileDeps['deliver']>;
  private readonly now: () => number;

  constructor(config: StatusReconcileConfig, deps: StatusReconcileDeps = {}, appConfig: Env = env) {
    this.config = config;
    this.findDue = deps.findDue ?? findStatusReportsForRetry;
    this.claim = deps.claim ?? claimStatusReportForRetry;
    this.deliver =
      deps.deliver ??
      ((leadId, lastFinalStatus, reason) =>
        deliverQueueFinalStatus(leadId, lastFinalStatus, reason, { config: appConfig }));
    this.now = deps.now ?? (() => Date.now());
  }

  async runSweep(): Promise<StatusReconcileSummary> {
    const summary: StatusReconcileSummary = {
      considered: 0,
      sent: 0,
      conflict: 0,
      failed: 0,
      invalid: 0,
      skippedLease: 0,
      errors: 0,
    };

    const nowMs = this.now();
    const due = await this.findDue(new Date(nowMs), this.config.maxAttempts, this.config.batchSize);
    summary.considered = due.length;

    let processed = 0;
    for (const report of due) {
      if (processed >= this.config.maxPerCycle) break;
      processed += 1;

      // Lease the row so a concurrent sweep does not also post it.
      const leaseUntil = new Date(this.now() + this.config.backoffMs);
      const claimed = await this.claim(report.leadId, new Date(this.now()), leaseUntil);
      if (!claimed) {
        summary.skippedLease += 1;
        continue;
      }

      try {
        const result = await this.deliver(
          report.leadId,
          report.lastFinalStatus,
          report.statusReportReason,
        );
        switch (result.outcome) {
          case 'sent':
            summary.sent += 1;
            break;
          case 'conflict':
            summary.conflict += 1;
            break;
          case 'invalid':
            summary.invalid += 1;
            break;
          default:
            summary.failed += 1;
        }
      } catch (error) {
        summary.errors += 1;
        logger.warn(
          { leadId: report.leadId, err: error instanceof Error ? error.name : 'unknown' },
          'status reconciliation: re-send raised unexpectedly; will retry next sweep',
        );
      }
    }

    logger.info(summary, 'Guided Boost status-report reconciliation sweep complete');
    return summary;
  }
}

/** Builds the status-report reconciliation sweeper from config, or null when disabled. */
export function buildStatusReconciliationSweeper(
  config: Env = env,
): StatusReconciliationSweeper | null {
  if (!config.CALLER_STATUS_RECONCILE_ENABLED) return null;
  return new StatusReconciliationSweeper(
    {
      maxAttempts: config.CALLER_STATUS_RETRY_MAX_ATTEMPTS,
      backoffMs: config.CALLER_STATUS_RETRY_BACKOFF_MS,
      maxPerCycle: config.LEAD_RECONCILE_MAX_PER_CYCLE,
      batchSize: config.LEAD_RECONCILE_BATCH_SIZE,
    },
    {},
    config,
  );
}
