import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { LeadApiClient } from '../integrations/leadApi/client.js';
import {
  findDueRetries,
  beginRetryAttempt,
  reschedulePendingRetry,
  type DueRetryLead,
} from '../repositories/leadProcessing.repository.js';
import { initiateCallForLead, type OrchestratorResult } from './callOrchestrator.service.js';
import { enqueueReviewNote } from './reviewNoteDelivery.service.js';

/**
 * Persistent, hold-aware no-answer call RETRY sweep.
 *
 * COMPLETELY SEPARATE from the NEEDS_REVIEW re-evaluation sweep: that one re-reads
 * eligibility DATA for leads stuck in NEEDS_REVIEW; this one RE-DIALS a lead whose
 * call was not answered. It shares nothing but the worker tick.
 *
 * Per due RETRY_PENDING lead (nextRetryAt in the past, attemptCount under the cap):
 *   1. Give-up check (no API call): if no valid caller hold has become available
 *      within `maxWaitMs` of the last actual dial, move the lead to NEEDS_REVIEW
 *      (reason `retry_hold_unavailable`) and notify the CRM — never silently drop it.
 *   2. Otherwise claim the retry (RETRY_PENDING -> ELIGIBLE, version-guarded so two
 *      workers cannot both begin it) and hand it to the SAME orchestrator the first
 *      call uses. The orchestrator re-runs every gate — eligibility, CRM gate,
 *      phone, the caller hold, RETELL_CALLING_ENABLED, DNC, claim/CAS — so the retry
 *      never bypasses a safety check and an expired hold is never dialled.
 *
 * The orchestrator persists the outcome itself (CALLING on a dial; RETRY_PENDING
 * again on an expired hold via finalizeHoldExpired, consuming NO attempt; SKIPPED on
 * a now-uncallable lead). The only persistence this sweep does directly is the
 * give-up transition and a safety-net reschedule for a lead the orchestrator left
 * ELIGIBLE without deciding (a transient read failure / calling disabled).
 *
 * All scheduling state is in the database (status + nextRetryAt + attemptCount), so
 * the sweep is fully restart-safe; there are no in-memory timers.
 */

export interface RetrySweepConfig {
  /** Dialling master switch — the sweep never strands a lead when this is off. */
  callingEnabled: boolean;
  maxAttempts: number;
  recheckMs: number;
  maxWaitMs: number;
  maxPerCycle: number;
  batchSize: number;
}

export interface RetrySweepSummary {
  /** Due RETRY_PENDING rows read this sweep. */
  considered: number;
  /** Retries handed to the orchestrator. */
  attempted: number;
  /** Orchestrator placed a call. */
  called: number;
  /** Hold not active: finalizeHoldExpired rescheduled to RETRY_PENDING (no attempt spent). */
  deferredHold: number;
  /** A transient/disabled outcome left the lead ELIGIBLE; rescheduled by the safety net. */
  deferredError: number;
  /** Lead became uncallable (eligibility/phone); orchestrator set it terminal (SKIPPED). */
  skipped: number;
  /** Past the max wait with no hold yet: a review note was ensured; the retry stays alive. */
  waitingForHold: number;
  /** Lost a version-guarded CAS (another worker moved the row). */
  races: number;
  /** callInitiator threw; caught, lead rescheduled. */
  errors: number;
  /** Any other orchestrator outcome (provider_*, duplicate_attempt, claim_failed). */
  other: number;
}

export interface RetrySweeperDeps {
  findDue?: (now: Date, maxAttempts: number, limit: number) => Promise<DueRetryLead[]>;
  begin?: (id: string, version: number) => Promise<boolean>;
  reschedule?: (leadId: string, nextRetryAt: Date) => Promise<boolean>;
  callInitiator?: (leadId: string) => Promise<OrchestratorResult>;
  enqueueReviewNote?: (leadId: string, reason: string, detail?: string) => Promise<unknown>;
  now?: () => number;
}

export class RetrySweeper {
  private readonly config: RetrySweepConfig;
  private readonly findDue: NonNullable<RetrySweeperDeps['findDue']>;
  private readonly begin: NonNullable<RetrySweeperDeps['begin']>;
  private readonly reschedule: NonNullable<RetrySweeperDeps['reschedule']>;
  private readonly callInitiator: NonNullable<RetrySweeperDeps['callInitiator']>;
  private readonly enqueueReviewNote: NonNullable<RetrySweeperDeps['enqueueReviewNote']>;
  private readonly now: () => number;

  constructor(config: RetrySweepConfig, deps: RetrySweeperDeps = {}) {
    this.config = config;
    this.findDue = deps.findDue ?? findDueRetries;
    this.begin = deps.begin ?? beginRetryAttempt;
    this.reschedule = deps.reschedule ?? reschedulePendingRetry;
    this.callInitiator = deps.callInitiator ?? ((leadId) => initiateCallForLead(leadId));
    this.enqueueReviewNote =
      deps.enqueueReviewNote ??
      ((leadId, reason, detail) => enqueueReviewNote(leadId, reason, detail));
    this.now = deps.now ?? (() => Date.now());
  }

  async runSweep(): Promise<RetrySweepSummary> {
    const summary: RetrySweepSummary = {
      considered: 0,
      attempted: 0,
      called: 0,
      deferredHold: 0,
      deferredError: 0,
      skipped: 0,
      waitingForHold: 0,
      races: 0,
      errors: 0,
      other: 0,
    };

    // Dialling off -> do nothing. Critically, we must not move any lead to ELIGIBLE
    // when the orchestrator would refuse to dial, or it would be left stranded.
    if (!this.config.callingEnabled) return summary;

    const nowMs = this.now();
    const due = await this.findDue(new Date(nowMs), this.config.maxAttempts, this.config.batchSize);
    summary.considered = due.length;

    let processed = 0;
    for (const lead of due) {
      if (processed >= this.config.maxPerCycle) break;
      processed += 1;

      const waitedMs = lead.lastAttemptAt ? nowMs - lead.lastAttemptAt.getTime() : 0;
      if (waitedMs >= this.config.maxWaitMs) {
        // Past the max wait with still no valid hold: surface it to the RM ONCE
        // (de-duplicated by the review-note intent) so they can re-issue a hold —
        // but DO NOT give up. The retry stays RETRY_PENDING and we still attempt
        // below, so it AUTO-RESUMES the moment a valid hold exists. No attempt is
        // consumed unless an active hold lets the orchestrator actually dial.
        try {
          await this.enqueueReviewNote(
            lead.leadId,
            'retry_hold_unavailable',
            'the no-answer retry has been waiting for a valid caller hold beyond the max wait',
          );
        } catch (error) {
          logger.warn(
            { leadId: lead.leadId, err: error instanceof Error ? error.name : 'unknown' },
            'retry sweep: waiting-for-hold notification raised unexpectedly; retry retained',
          );
        }
        summary.waitingForHold += 1;
        // fall through and still attempt (a hold may now be active)
      }

      const began = await this.begin(lead.id, lead.version);
      if (!began) {
        summary.races += 1;
        continue;
      }

      summary.attempted += 1;
      let result: OrchestratorResult;
      try {
        result = await this.callInitiator(lead.leadId);
      } catch (error) {
        summary.errors += 1;
        logger.warn(
          { leadId: lead.leadId, err: error instanceof Error ? error.name : 'unknown' },
          'retry sweep: call attempt raised unexpectedly; rescheduling the retry',
        );
        await this.reschedule(lead.leadId, new Date(nowMs + this.config.recheckMs));
        continue;
      }

      switch (result.outcome) {
        case 'call_initiated':
          summary.called += 1;
          break;
        case 'rejected_hold_expired':
          // finalizeHoldExpired already returned it to RETRY_PENDING (no attempt spent).
          summary.deferredHold += 1;
          break;
        case 'rejected_eligibility':
        case 'rejected_phone':
          // The orchestrator persisted a terminal decision (SKIPPED / NEEDS_REVIEW).
          summary.skipped += 1;
          break;
        case 'lead_unavailable':
        case 'calling_disabled':
          // The orchestrator returned before persisting, leaving the lead ELIGIBLE.
          summary.deferredError += 1;
          await this.reschedule(lead.leadId, new Date(nowMs + this.config.recheckMs));
          break;
        default:
          // provider_uncertain / provider_failed / duplicate_attempt / claim_failed:
          // the orchestrator already owns the resulting state.
          summary.other += 1;
          break;
      }
    }

    logger.info(summary, 'no-answer retry sweep complete');
    return summary;
  }
}

/**
 * Builds the retry sweeper from config, or null when the feature is disabled. The
 * lead worker invokes `runSweep()` once per poll cycle.
 */
export function buildRetrySweeper(config: Env = env): RetrySweeper | null {
  if (!config.LEAD_RETRY_ENABLED) return null;
  const client = new LeadApiClient({}, config);
  return new RetrySweeper(
    {
      callingEnabled: config.RETELL_CALLING_ENABLED,
      maxAttempts: config.LEAD_RETRY_MAX_ATTEMPTS,
      recheckMs: config.LEAD_RETRY_RECHECK_MS,
      maxWaitMs: config.LEAD_RETRY_MAX_WAIT_MS,
      maxPerCycle: config.LEAD_RETRY_MAX_PER_CYCLE,
      batchSize: config.LEAD_RETRY_BATCH_SIZE,
    },
    { callInitiator: (leadId) => initiateCallForLead(leadId, { config, leadApiClient: client }) },
  );
}
