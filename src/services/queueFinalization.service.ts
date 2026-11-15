import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  findPendingFinalizations,
  claimPendingFinalization,
  type DueStatusReport,
} from '../repositories/leadProcessing.repository.js';
import { deliverQueueFinalStatus, type DeliverResult } from './guidedBoostStatus.service.js';

/**
 * Finalization sweep (Step 9): sends the FIRST final status for terminal QUEUE calls
 * whose bounded artifact-wait window has elapsed.
 *
 * On a terminal QUEUE call the webhook only ENQUEUES a `pending` finalization (with a
 * short deadline so late `call_analyzed` artifacts can land on the CallRecord). This
 * sweep picks those up when due and delivers the final status WITH whatever artifacts
 * are now present, via the shared `deliverQueueFinalStatus` (which reads the enriched
 * CallRecord and persists `sent`/`failed`). A `failed` delivery is then retried by the
 * Step 7 reconciliation sweep.
 *
 * It imports nothing from the orchestrator/Retell, so it can never place a call. A
 * per-lead CAS lease makes concurrent sweeps safe.
 */

export interface FinalizationConfig {
  leaseMs: number;
  maxPerCycle: number;
  batchSize: number;
}

export interface FinalizationSummary {
  considered: number;
  sent: number;
  conflict: number;
  failed: number;
  invalid: number;
  skippedLease: number;
  errors: number;
}

export interface FinalizationDeps {
  findDue?: (now: Date, limit: number) => Promise<DueStatusReport[]>;
  claim?: (leadId: string, now: Date, leaseUntil: Date) => Promise<boolean>;
  deliver?: (
    leadId: string,
    lastFinalStatus: string,
    reason: string | null,
  ) => Promise<DeliverResult>;
  now?: () => number;
}

export class FinalizationSweeper {
  private readonly config: FinalizationConfig;
  private readonly findDue: NonNullable<FinalizationDeps['findDue']>;
  private readonly claim: NonNullable<FinalizationDeps['claim']>;
  private readonly deliver: NonNullable<FinalizationDeps['deliver']>;
  private readonly now: () => number;

  constructor(config: FinalizationConfig, deps: FinalizationDeps = {}, appConfig: Env = env) {
    this.config = config;
    this.findDue = deps.findDue ?? findPendingFinalizations;
    this.claim = deps.claim ?? claimPendingFinalization;
    this.deliver =
      deps.deliver ??
      ((leadId, lastFinalStatus, reason) =>
        deliverQueueFinalStatus(leadId, lastFinalStatus, reason, { config: appConfig }));
    this.now = deps.now ?? (() => Date.now());
  }

  async runSweep(): Promise<FinalizationSummary> {
    const summary: FinalizationSummary = {
      considered: 0,
      sent: 0,
      conflict: 0,
      failed: 0,
      invalid: 0,
      skippedLease: 0,
      errors: 0,
    };

    const due = await this.findDue(new Date(this.now()), this.config.batchSize);
    summary.considered = due.length;

    let processed = 0;
    for (const report of due) {
      if (processed >= this.config.maxPerCycle) break;
      processed += 1;

      const leaseUntil = new Date(this.now() + this.config.leaseMs);
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
          'queue finalization: delivery raised unexpectedly; will retry next sweep',
        );
      }
    }

    logger.info(summary, 'QUEUE finalization sweep complete');
    return summary;
  }
}

/** Builds the finalization sweeper. Always active with the queue worker (core flow). */
export function buildFinalizationSweeper(config: Env = env): FinalizationSweeper {
  return new FinalizationSweeper(
    {
      leaseMs: config.CALLER_STATUS_RETRY_BACKOFF_MS,
      maxPerCycle: config.LEAD_RECONCILE_MAX_PER_CYCLE,
      batchSize: config.LEAD_RECONCILE_BATCH_SIZE,
    },
    {},
    config,
  );
}
