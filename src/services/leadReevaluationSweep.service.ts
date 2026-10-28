import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { LeadApiClient } from '../integrations/leadApi/client.js';
import { LeadApiError, describeLeadApiError } from '../integrations/leadApi/errors.js';
import {
  findReevaluableLeads,
  type ReevaluableLead,
} from '../repositories/leadProcessing.repository.js';
import {
  reevaluateNeedsReviewLead,
  REEVALUATABLE_REASONS,
  type ReevaluationResult,
} from './leadReevaluation.service.js';

/**
 * Bounded, throttled automatic re-evaluation of leads stuck in NEEDS_REVIEW.
 *
 * Runs after each worker poll cycle (when enabled). It does NOT re-check every
 * NEEDS_REVIEW lead every cycle: each lead has a per-lead retry schedule
 * (interval × backoff^attempt, measured from its `decidedAt`) and a hard attempt
 * cap, and the sweep performs at most `maxPerCycle` Lead API re-evaluations per
 * run. All correctness still comes from `reevaluateNeedsReviewLead`, which reuses
 * the normal eligibility checks (including `LEAD_BLOCKED_STATUSES` — an
 * Unsubscribed lead resolves to SKIPPED, never promoted/called), the phone
 * verdict, `RETELL_CALLING_ENABLED`, and the version-guarded CAS. This class adds
 * only scheduling; it can never promote or call a lead on its own.
 *
 * Retry state is kept IN MEMORY (per process). A restart resets the attempt
 * counters, so a lead gets a fresh (still-bounded, still-throttled) budget — an
 * acceptable, safe property for a best-effort recovery sweep: the CAS guarantees
 * no unsafe or duplicate decision regardless of how often a lead is re-checked,
 * and across replicas each process throttles independently while the CAS keeps
 * exactly one decision winning. No schema change or extra persisted state is
 * required.
 */

export interface SweepConfig {
  retryIntervalMs: number;
  backoffFactor: number;
  maxAttempts: number;
  maxPerCycle: number;
  batchSize: number;
}

export interface SweepSummary {
  /** Candidate NEEDS_REVIEW rows read from the DB this sweep. */
  considered: number;
  /** Leads skipped because their next retry time has not arrived yet. */
  notDue: number;
  /** Leads skipped because they already exhausted their attempt budget. */
  exhausted: number;
  /** Leads actually re-evaluated (one Lead API read each) this sweep. */
  attempted: number;
  /** Became ELIGIBLE. */
  promoted: number;
  /** Resolved to SKIPPED (e.g. now Unsubscribed / blocked status). */
  resolvedSkipped: number;
  /** Still NEEDS_REVIEW after the fresh check. */
  stillUnchanged: number;
  /** Newly exhausted this sweep (hit the attempt cap). */
  newlyExhausted: number;
  /** Lost the version-guarded CAS race (another process moved the row). */
  races: number;
  /** Per-lead errors caught (never thrown out of the sweep). */
  errors: number;
}

interface RetryState {
  attempts: number;
  exhausted: boolean;
}

export interface SweeperDeps {
  findCandidates?: (reasons: readonly string[], limit: number) => Promise<ReevaluableLead[]>;
  reevaluate?: (leadId: string) => Promise<ReevaluationResult>;
  now?: () => number;
}

export class ReevaluationSweeper {
  private readonly config: SweepConfig;
  private readonly findCandidates: (
    reasons: readonly string[],
    limit: number,
  ) => Promise<ReevaluableLead[]>;
  private readonly reevaluate: (leadId: string) => Promise<ReevaluationResult>;
  private readonly now: () => number;
  /** Per-lead retry state, in memory for this process. */
  private readonly state = new Map<string, RetryState>();

  constructor(config: SweepConfig, deps: SweeperDeps = {}) {
    this.config = config;
    this.findCandidates = deps.findCandidates ?? findReevaluableLeads;
    this.reevaluate = deps.reevaluate ?? ((leadId) => reevaluateNeedsReviewLead(leadId));
    this.now = deps.now ?? (() => Date.now());
  }

  /** When a lead's next attempt becomes due, from its decision time + backoff. */
  private dueAt(decidedAt: Date | null, attempts: number): number {
    const base = decidedAt ? decidedAt.getTime() : 0;
    const factor = this.config.backoffFactor ** attempts;
    return base + this.config.retryIntervalMs * factor;
  }

  async runSweep(): Promise<SweepSummary> {
    const summary: SweepSummary = {
      considered: 0,
      notDue: 0,
      exhausted: 0,
      attempted: 0,
      promoted: 0,
      resolvedSkipped: 0,
      stillUnchanged: 0,
      newlyExhausted: 0,
      races: 0,
      errors: 0,
    };

    const candidates = await this.findCandidates(REEVALUATABLE_REASONS, this.config.batchSize);
    summary.considered = candidates.length;
    const now = this.now();
    const liveLeadIds = new Set<string>();

    for (const candidate of candidates) {
      liveLeadIds.add(candidate.leadId);
      if (summary.attempted >= this.config.maxPerCycle) {
        // Per-cycle Lead API budget spent; the rest wait for the next sweep.
        break;
      }

      const existing = this.state.get(candidate.leadId);
      if (existing?.exhausted) {
        summary.exhausted += 1;
        continue;
      }
      const attempts = existing?.attempts ?? 0;
      if (now < this.dueAt(candidate.decidedAt, attempts)) {
        summary.notDue += 1;
        continue;
      }

      summary.attempted += 1;
      let result: ReevaluationResult;
      try {
        result = await this.reevaluate(candidate.leadId);
      } catch (error) {
        // A failure must never abort the whole sweep. How we schedule a retry
        // depends on whether the failure can plausibly recover:
        //
        //   - PERMANENT (auth / not-found / other 4xx / contract): retrying can
        //     never help, so stop re-attempting this lead for the process
        //     lifetime. It stays NEEDS_REVIEW (recoverable on restart or by hand)
        //     — never marked terminal/SKIPPED on a mere fetch failure — and no
        //     longer consumes the per-cycle budget, so it can't starve other leads.
        //   - TRANSIENT (network / timeout / 5xx / rate-limit): may recover, so
        //     count it against the bounded attempt budget. Subsequent retries back
        //     off (dueAt grows with attempts) and eventually exhaust at
        //     `maxAttempts`, instead of re-hitting the same lead every sweep.
        summary.errors += 1;
        const safe =
          error instanceof LeadApiError
            ? describeLeadApiError(error)
            : { kind: 'unknown', err: error instanceof Error ? error.name : 'unknown' };
        const permanent = error instanceof LeadApiError && error.permanent;

        if (permanent) {
          this.markExhausted(candidate.leadId, summary);
          logger.warn(
            { leadId: candidate.leadId, reason: candidate.decisionReason, ...safe },
            'reevaluation sweep: permanent Lead API error; not retrying this lead',
          );
        } else {
          const exhausted = this.bumpAttempt(candidate.leadId, summary);
          logger.warn(
            { leadId: candidate.leadId, reason: candidate.decisionReason, exhausted, ...safe },
            'reevaluation sweep: transient Lead API error; will retry with backoff',
          );
        }
        continue;
      }

      this.applyOutcome(candidate, result, summary);
    }

    // Drop in-memory state for leads no longer NEEDS_REVIEW (left the candidate
    // set), so the map cannot grow without bound.
    for (const leadId of [...this.state.keys()]) {
      if (!liveLeadIds.has(leadId)) this.state.delete(leadId);
    }

    logger.info(summary, 'reevaluation sweep complete');
    return summary;
  }

  private applyOutcome(
    candidate: ReevaluableLead,
    result: ReevaluationResult,
    summary: SweepSummary,
  ): void {
    switch (result.outcome) {
      case 'promoted':
        summary.promoted += 1;
        this.state.delete(candidate.leadId);
        return;
      case 'resolved_skipped':
        summary.resolvedSkipped += 1;
        this.state.delete(candidate.leadId);
        return;
      case 'not_needs_review':
      case 'not_found':
      case 'reason_not_reevaluable':
        // No longer our concern; forget it.
        this.state.delete(candidate.leadId);
        return;
      case 'race_not_applied':
        summary.races += 1;
        this.bumpAttempt(candidate.leadId, summary);
        return;
      case 'unchanged':
        summary.stillUnchanged += 1;
        this.bumpAttempt(candidate.leadId, summary);
        return;
    }
  }

  private bumpAttempt(leadId: string, summary: SweepSummary): boolean {
    const attempts = (this.state.get(leadId)?.attempts ?? 0) + 1;
    const exhausted = attempts >= this.config.maxAttempts;
    this.state.set(leadId, { attempts, exhausted });
    if (exhausted) {
      summary.newlyExhausted += 1;
      logger.warn(
        { leadId, attempts },
        'reevaluation sweep: lead exhausted its retry budget; leaving it NEEDS_REVIEW',
      );
    }
    return exhausted;
  }

  /**
   * Marks a lead as no longer retryable this process lifetime (a permanent
   * error). It keeps whatever attempt count it had, is skipped on later sweeps by
   * the `exhausted` guard, and is never marked terminal in the database.
   */
  private markExhausted(leadId: string, summary: SweepSummary): void {
    const prev = this.state.get(leadId);
    if (!prev?.exhausted) summary.newlyExhausted += 1;
    this.state.set(leadId, { attempts: prev?.attempts ?? 0, exhausted: true });
  }
}

/**
 * Builds the process sweeper from config, or null when disabled. The caller
 * (the lead worker) invokes `runSweep()` once per poll cycle.
 */
export function buildReevaluationSweeper(config: Env = env): ReevaluationSweeper | null {
  if (!config.LEAD_REEVAL_ENABLED) return null;
  // A single shared Lead API client for the sweep's re-evaluations.
  const client = new LeadApiClient({}, config);
  return new ReevaluationSweeper(
    {
      retryIntervalMs: config.LEAD_REEVAL_RETRY_INTERVAL_MS,
      backoffFactor: config.LEAD_REEVAL_BACKOFF_FACTOR,
      maxAttempts: config.LEAD_REEVAL_MAX_ATTEMPTS,
      maxPerCycle: config.LEAD_REEVAL_MAX_PER_CYCLE,
      batchSize: config.LEAD_REEVAL_BATCH_SIZE,
    },
    { reevaluate: (leadId) => reevaluateNeedsReviewLead(leadId, { client, config }) },
  );
}
