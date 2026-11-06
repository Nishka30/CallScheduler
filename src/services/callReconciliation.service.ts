import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { LeadApiClient } from '../integrations/leadApi/client.js';
import {
  findStuckCalling,
  findStuckProcessing,
  findEligibleNotCalled,
  reconcileStuckCalling,
  requeueStuckProcessing,
  type ReconcileLead,
} from '../repositories/leadProcessing.repository.js';
import { initiateCallForLead, type OrchestratorResult } from './callOrchestrator.service.js';
import { enqueueReviewNote } from './reviewNoteDelivery.service.js';

/**
 * Reconciliation sweep that recovers leads stranded in an in-progress state by a
 * missing webhook, a crash, or a transient failure — so no lead silently disappears.
 *
 * Three independent, error-contained phases:
 *   1. **Stuck CALLING** (terminal webhook missed): CALLING -> NEEDS_REVIEW
 *      (`call_unreconciled`) + CRM note. SAFE FALLBACK — the call may have connected,
 *      so it is NEVER auto-redialled and NEVER marked completed. (Retell has no read
 *      endpoint wired, so we cannot query the real state; this surfaces it for review.)
 *   2. **Stuck PROCESSING** (crashed after claim, before it dialled — no call placed):
 *      PROCESSING -> ELIGIBLE, un-counting the dial-less claim.
 *   3. **ELIGIBLE backstop** (left ELIGIBLE but not called — a transient
 *      `lead_unavailable`, or a crash mid-retry): re-hand to the orchestrator, which
 *      re-applies EVERY gate (hold, CRM, phone, claim). Skipped entirely when calling
 *      is disabled, so it can never strand a lead in ELIGIBLE with no dialler.
 *
 * Every transition is a version-guarded CAS (safe under concurrent workers and
 * duplicate execution); duplicate calls are prevented by the orchestrator's claim and
 * the active-attempt unique guard.
 */

export interface CallReconcileConfig {
  callingEnabled: boolean;
  stuckCallingMs: number;
  stuckProcessingMs: number;
  eligibleBackstopMs: number;
  maxPerCycle: number;
  batchSize: number;
}

export interface CallReconcileSummary {
  stuckCalling: number;
  reconciledCalling: number;
  stuckProcessing: number;
  requeuedProcessing: number;
  eligibleBackstop: number;
  backstopAttempted: number;
  races: number;
  errors: number;
}

export interface CallReconcileDeps {
  findStuckCalling?: (olderThan: Date, limit: number) => Promise<ReconcileLead[]>;
  findStuckProcessing?: (olderThan: Date, limit: number) => Promise<ReconcileLead[]>;
  findEligibleNotCalled?: (olderThan: Date, limit: number) => Promise<ReconcileLead[]>;
  reconcileStuckCalling?: (id: string, version: number, now: Date) => Promise<boolean>;
  requeueStuckProcessing?: (id: string, version: number, now: Date) => Promise<boolean>;
  callInitiator?: (leadId: string) => Promise<OrchestratorResult>;
  enqueueReviewNote?: (leadId: string, reason: string, detail?: string) => Promise<unknown>;
  now?: () => number;
}

export class CallReconciliationSweeper {
  private readonly config: CallReconcileConfig;
  private readonly findStuckCalling: NonNullable<CallReconcileDeps['findStuckCalling']>;
  private readonly findStuckProcessing: NonNullable<CallReconcileDeps['findStuckProcessing']>;
  private readonly findEligibleNotCalled: NonNullable<CallReconcileDeps['findEligibleNotCalled']>;
  private readonly reconcileStuckCalling: NonNullable<CallReconcileDeps['reconcileStuckCalling']>;
  private readonly requeueStuckProcessing: NonNullable<CallReconcileDeps['requeueStuckProcessing']>;
  private readonly callInitiator: NonNullable<CallReconcileDeps['callInitiator']>;
  private readonly enqueueReviewNote: NonNullable<CallReconcileDeps['enqueueReviewNote']>;
  private readonly now: () => number;

  constructor(config: CallReconcileConfig, deps: CallReconcileDeps = {}) {
    this.config = config;
    this.findStuckCalling = deps.findStuckCalling ?? findStuckCalling;
    this.findStuckProcessing = deps.findStuckProcessing ?? findStuckProcessing;
    this.findEligibleNotCalled = deps.findEligibleNotCalled ?? findEligibleNotCalled;
    this.reconcileStuckCalling = deps.reconcileStuckCalling ?? reconcileStuckCalling;
    this.requeueStuckProcessing = deps.requeueStuckProcessing ?? requeueStuckProcessing;
    this.callInitiator = deps.callInitiator ?? ((leadId) => initiateCallForLead(leadId));
    this.enqueueReviewNote =
      deps.enqueueReviewNote ??
      ((leadId, reason, detail) => enqueueReviewNote(leadId, reason, detail));
    this.now = deps.now ?? (() => Date.now());
  }

  async runSweep(): Promise<CallReconcileSummary> {
    const summary: CallReconcileSummary = {
      stuckCalling: 0,
      reconciledCalling: 0,
      stuckProcessing: 0,
      requeuedProcessing: 0,
      eligibleBackstop: 0,
      backstopAttempted: 0,
      races: 0,
      errors: 0,
    };
    const nowMs = this.now();

    // Phase 1: stuck CALLING -> NEEDS_REVIEW/call_unreconciled + CRM note.
    try {
      const stuck = await this.findStuckCalling(
        new Date(nowMs - this.config.stuckCallingMs),
        this.config.batchSize,
      );
      summary.stuckCalling = stuck.length;
      for (const row of stuck.slice(0, this.config.maxPerCycle)) {
        const ok = await this.reconcileStuckCalling(row.id, row.version, new Date(nowMs));
        if (!ok) {
          summary.races += 1;
          continue;
        }
        summary.reconciledCalling += 1;
        try {
          await this.enqueueReviewNote(
            row.leadId,
            'call_unreconciled',
            'call stuck in CALLING past the reconciliation timeout; no terminal webhook received',
          );
        } catch (error) {
          logger.warn(
            { leadId: row.leadId, err: error instanceof Error ? error.name : 'unknown' },
            'call reconciliation: review-note enqueue raised unexpectedly; decision retained',
          );
        }
      }
    } catch (error) {
      summary.errors += 1;
      logger.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        'call reconciliation: stuck-CALLING phase failed (other phases continue)',
      );
    }

    // Phase 2: stuck PROCESSING -> ELIGIBLE (no dial was placed in PROCESSING).
    try {
      const stuck = await this.findStuckProcessing(
        new Date(nowMs - this.config.stuckProcessingMs),
        this.config.batchSize,
      );
      summary.stuckProcessing = stuck.length;
      for (const row of stuck.slice(0, this.config.maxPerCycle)) {
        const ok = await this.requeueStuckProcessing(row.id, row.version, new Date(nowMs));
        if (ok) summary.requeuedProcessing += 1;
        else summary.races += 1;
      }
    } catch (error) {
      summary.errors += 1;
      logger.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        'call reconciliation: stuck-PROCESSING phase failed (other phases continue)',
      );
    }

    // Phase 3: ELIGIBLE backstop -> orchestrator. Only when calling is enabled, so
    // we never move work toward a dialler that will refuse and strand it.
    if (this.config.callingEnabled) {
      try {
        const eligible = await this.findEligibleNotCalled(
          new Date(nowMs - this.config.eligibleBackstopMs),
          this.config.batchSize,
        );
        summary.eligibleBackstop = eligible.length;
        for (const row of eligible.slice(0, this.config.maxPerCycle)) {
          try {
            await this.callInitiator(row.leadId);
            summary.backstopAttempted += 1;
          } catch (error) {
            summary.errors += 1;
            logger.warn(
              { leadId: row.leadId, err: error instanceof Error ? error.name : 'unknown' },
              'call reconciliation: backstop call attempt raised; will retry next sweep',
            );
          }
        }
      } catch (error) {
        summary.errors += 1;
        logger.error(
          { err: error instanceof Error ? error.name : 'unknown' },
          'call reconciliation: ELIGIBLE-backstop phase failed (other phases continue)',
        );
      }
    }

    logger.info(summary, 'call reconciliation sweep complete');
    return summary;
  }
}

/** Builds the call-reconciliation sweeper from config, or null when disabled. */
export function buildCallReconciliationSweeper(
  config: Env = env,
): CallReconciliationSweeper | null {
  if (!config.LEAD_RECONCILE_ENABLED) return null;
  const client = new LeadApiClient({}, config);
  return new CallReconciliationSweeper(
    {
      callingEnabled: config.RETELL_CALLING_ENABLED,
      stuckCallingMs: config.LEAD_STUCK_CALLING_MS,
      stuckProcessingMs: config.LEAD_STUCK_PROCESSING_MS,
      eligibleBackstopMs: config.LEAD_ELIGIBLE_BACKSTOP_MS,
      maxPerCycle: config.LEAD_RECONCILE_MAX_PER_CYCLE,
      batchSize: config.LEAD_RECONCILE_BATCH_SIZE,
    },
    { callInitiator: (leadId) => initiateCallForLead(leadId, { config, leadApiClient: client }) },
  );
}
