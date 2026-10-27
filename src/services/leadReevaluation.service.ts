import { ProcessingStatus } from '@prisma/client';
import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { LeadApiClient } from '../integrations/leadApi/client.js';
import type { LeadDetail } from '../integrations/leadApi/schemas.js';
import {
  evaluateListEligibility,
  parseTimestamp,
  type EligibilityDecision,
  type EligibilityReason,
} from './leadEligibility.service.js';
import { resolveWithContext, toProcessingStatus } from './leadPolling.service.js';
import { toListRow } from './callOrchestrator.service.js';
import { initiateCallForLead, type OrchestratorResult } from './callOrchestrator.service.js';
import {
  findByLeadId,
  reevaluateNeedsReviewDecision,
} from '../repositories/leadProcessing.repository.js';

/**
 * Explicit, single-lead re-evaluation for a lead STUCK in `NEEDS_REVIEW`.
 *
 * Why this exists: `recordLeadDecision` (the normal poll path) deliberately
 * NEVER transitions a lead out of NEEDS_REVIEW once recorded - correct, because
 * a later note/status edit must never retroactively promote an old lead. But
 * some NEEDS_REVIEW reasons are not a business decision at all, just a
 * DATA-AVAILABILITY gap at the moment we first looked (the phone verdict object
 * had not been created yet, auto-eligibility was off, a person-history lookup
 * failed, etc.). Once that gap closes, nothing in the automatic poll path will
 * ever re-check the lead, because it no longer appears to the decision-recording
 * step as "PENDING".
 *
 * This function is the deliberate, narrow exception: given one lead id, it
 * re-fetches FRESH detail and re-runs the EXACT SAME eligibility logic the
 * automatic path uses (`evaluateListEligibility` + `resolveWithContext`, both
 * reused directly - never duplicated), then applies the result via a
 * version-guarded compare-and-swap that can ONLY move a lead OUT OF
 * `NEEDS_REVIEW` - never touching PENDING, ELIGIBLE, SKIPPED, PROCESSING,
 * CALLING, COMPLETED or FAILED. It is invoked only on deliberate operator
 * request (the `reevaluateLead` CLI script), never from the background worker,
 * so it never floods the Lead API re-checking every NEEDS_REVIEW lead on every
 * cycle.
 *
 * Only reasons that represent a genuine data/config gap are re-evaluated (see
 * `REEVALUATABLE_REASONS`); a reason outside that list is refused rather than
 * silently reinterpreted.
 */

/**
 * The only `NEEDS_REVIEW` reasons this function will act on. Every current
 * NEEDS_REVIEW-producing reason is a "we could not decide, not a business
 * rule", but this is an explicit allow-list (not "all NEEDS_REVIEW reasons") so
 * a FUTURE new reason requires a deliberate decision to include it here, rather
 * than being silently re-evaluated.
 */
export const REEVALUATABLE_REASONS = [
  'is_lead_field_absent',
  'lead_status_field_absent',
  'created_at_field_absent',
  'phone_verdict_unreadable',
  'person_key_absent',
  'context_lookup_failed',
  'awaiting_new_lead_rule_confirmation',
] as const satisfies readonly EligibilityReason[];

export type ReevaluationOutcome =
  /** No local processing record exists for this lead id. */
  | 'not_found'
  /** The lead is not currently NEEDS_REVIEW (nothing to re-evaluate). */
  | 'not_needs_review'
  /** The recorded reason is not one this function will act on. */
  | 'reason_not_reevaluable'
  /** Another process changed the row between our read and write; not retried. */
  | 'race_not_applied'
  /** Still NEEDS_REVIEW after the fresh check (reason/detail refreshed). */
  | 'unchanged'
  /** Freshly decided ELIGIBLE. */
  | 'promoted'
  /** Freshly decided SKIPPED (e.g. the lead is now opted out). */
  | 'resolved_skipped';

export interface ReevaluationResult {
  leadId: string;
  outcome: ReevaluationOutcome;
  previousReason?: string;
  newReason?: string;
  newStatus?: ProcessingStatus;
  /** Present only when a fresh ELIGIBLE was handed to the orchestrator. */
  callOutcome?: OrchestratorResult['outcome'];
}

export interface ReevaluationDeps {
  client?: LeadApiClient;
  config?: Env;
  now?: () => Date;
  callInitiator?: typeof initiateCallForLead;
}

export async function reevaluateNeedsReviewLead(
  leadId: string,
  deps: ReevaluationDeps = {},
): Promise<ReevaluationResult> {
  const config = deps.config ?? env;
  const now = deps.now ?? (() => new Date());
  const client = deps.client ?? new LeadApiClient({}, config);
  const callInitiator = deps.callInitiator ?? initiateCallForLead;

  const row = await findByLeadId(leadId);
  if (!row) {
    return { leadId, outcome: 'not_found' };
  }
  if (row.status !== ProcessingStatus.NEEDS_REVIEW) {
    return { leadId, outcome: 'not_needs_review' };
  }

  const previousReason = row.decisionReason ?? undefined;
  const reevaluable =
    previousReason !== undefined &&
    (REEVALUATABLE_REASONS as readonly string[]).includes(previousReason);
  if (!reevaluable) {
    return {
      leadId,
      outcome: 'reason_not_reevaluable',
      ...(previousReason === undefined ? {} : { previousReason }),
    };
  }

  // Fresh detail. A transient failure propagates (never silently swallowed) so
  // the operator sees it and can simply re-run the script; the row is left
  // untouched (no partial/guessed write).
  const detail: LeadDetail = await client.getLead(leadId);
  const listRow = toListRow(leadId, detail);

  let decision: EligibilityDecision = evaluateListEligibility({
    row: listRow,
    // This lead already exists in our table from an earlier poll - it is, by
    // definition, not a "known before bootstrap" row. Never re-derive that.
    isBootstrapRun: false,
    now: now(),
    config,
  });
  if (decision.outcome === 'ELIGIBLE') {
    decision = await resolveWithContext(leadId, listRow, client);
  }

  const leadUpdatedAt = parseTimestamp(listRow.updated_at) ?? undefined;
  const applied = await reevaluateNeedsReviewDecision(
    row.id,
    row.version,
    {
      status: toProcessingStatus(decision.outcome),
      reason: decision.reason,
      ...(decision.detail === undefined ? {} : { detail: decision.detail }),
      ...(leadUpdatedAt === undefined ? {} : { leadUpdatedAt }),
    },
    now(),
  );

  if (!applied.applied) {
    logger.warn(
      { leadId },
      'lead re-evaluation: lead changed state before our write applied; not retried',
    );
    return { leadId, outcome: 'race_not_applied', previousReason, newReason: decision.reason };
  }

  logger.info(
    { leadId, previousReason, newReason: decision.reason, newStatus: decision.outcome },
    'lead re-evaluation applied',
  );

  if (decision.outcome === 'SKIPPED') {
    return {
      leadId,
      outcome: 'resolved_skipped',
      previousReason,
      newReason: decision.reason,
      newStatus: applied.record.status,
    };
  }

  if (decision.outcome === 'NEEDS_REVIEW') {
    return {
      leadId,
      outcome: 'unchanged',
      previousReason,
      newReason: decision.reason,
      newStatus: applied.record.status,
    };
  }

  // ELIGIBLE: mirror the automatic poll path exactly - hand off to the
  // orchestrator only when the master switch is on. Calling stays gated here
  // exactly as everywhere else; this function never bypasses it.
  if (config.RETELL_CALLING_ENABLED) {
    const call = await callInitiator(leadId, { config, leadApiClient: client });
    return {
      leadId,
      outcome: 'promoted',
      previousReason,
      newReason: decision.reason,
      newStatus: applied.record.status,
      callOutcome: call.outcome,
    };
  }

  return {
    leadId,
    outcome: 'promoted',
    previousReason,
    newReason: decision.reason,
    newStatus: applied.record.status,
  };
}
