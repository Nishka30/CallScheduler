import { randomUUID } from 'node:crypto';
import { env, requireRetellCallingEnabled, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { LeadApiClient } from '../integrations/leadApi/client.js';
import { LeadApiError } from '../integrations/leadApi/errors.js';
import { RetellClient } from '../integrations/retell/client.js';
import { RetellApiError, describeRetellError } from '../integrations/retell/errors.js';
import type { LeadDetail, LeadListRow } from '../integrations/leadApi/schemas.js';
import { evaluateListEligibility, readPhoneVerdict } from './leadEligibility.service.js';
import { evaluateCrmGate } from './crmGate.service.js';
import { evaluateCallWindow, isHoldActive } from './callWindow.service.js';
import { buildLeadCallContext, describeContextForLog } from './leadContext.service.js';
import { buildAgentDynamicVariables } from '../integrations/retell/dynamicVariables.js';
import {
  claimEligibleLead,
  markCalling,
  completeProcessing,
  finalizeRejectedEligibleLead,
  finalizeHoldExpired,
} from '../repositories/leadProcessing.repository.js';
import {
  recordCallAttempt,
  attachProviderCallId,
  markCallAttemptFailed,
} from '../repositories/callRecord.repository.js';
import { deliverCallNote } from './callNoteDelivery.service.js';
import { enqueueReviewNote } from './reviewNoteDelivery.service.js';
import { ProcessingStatus } from '@prisma/client';

/**
 * End-to-end outbound-call orchestrator.
 *
 * Wires the already-built pieces (Lead API reads, eligibility, caller-hold,
 * call-context, processing-state machine, call-record lifecycle, Retell client)
 * into one guarded sequence for a single lead. It is **not** wired into polling
 * and places no call unless `RETELL_CALLING_ENABLED` is true — which it checks
 * first, before any external request or DB write.
 *
 * It never writes to the CRM, never changes CRM lead status, and never assumes a
 * booking. All state stays in the local `ai_caller` database.
 */

export type OrchestratorOutcome =
  /** Master switch is off — nothing was done (the default state). */
  | 'calling_disabled'
  /** The Lead API read (detail/person) failed; nothing was attempted. */
  | 'lead_unavailable'
  /** Hard eligibility rule failed (deleted / not a lead / blocked status / undecidable). */
  | 'rejected_eligibility'
  /** Phone is not a validated E.164 number. */
  | 'rejected_phone'
  /** The caller hold is not active (null / expired) — do not call late. */
  | 'rejected_hold_expired'
  /** Could not claim the lead (not ELIGIBLE, or another worker won the race). */
  | 'claim_failed'
  /** An unresolved call attempt already exists for this lead. */
  | 'duplicate_attempt'
  /** Retell accepted the call; provider call id is linked. */
  | 'call_initiated'
  /** Provider timeout / 5xx AFTER the request — the call may have happened; must reconcile. */
  | 'provider_uncertain'
  /** Provider refused before dialling (auth/config/invalid destination/4xx). */
  | 'provider_failed';

export interface OrchestratorResult {
  outcome: OrchestratorOutcome;
  leadId: string;
  /** Machine-readable sub-reason (e.g. the eligibility reason), safe to log. */
  reason?: string;
  callRecordId?: string;
  retellCallId?: string;
}

export interface OrchestratorDeps {
  leadApiClient?: LeadApiClient;
  retellClient?: RetellClient;
  config?: Env;
  workerId?: string;
  now?: () => Date;
}

/**
 * Attempts one outbound call for a single lead, running the full guarded flow.
 *
 * Order is deliberate: the disabled-switch guard comes first (so a disabled
 * system does nothing at all), then read-only Lead API validation, then the
 * atomic claim + attempt record + state transition, and only then the call.
 */
export async function initiateCallForLead(
  leadId: string,
  deps: OrchestratorDeps = {},
): Promise<OrchestratorResult> {
  const config = deps.config ?? env;
  const now = deps.now ?? (() => new Date());
  const workerId = deps.workerId ?? `orchestrator-${randomUUID()}`;

  // 1. Master switch. While off, do nothing external and nothing in the DB.
  try {
    requireRetellCallingEnabled(config);
  } catch {
    logger.info({ leadId }, 'call orchestrator: calling disabled, no action taken');
    return { outcome: 'calling_disabled', leadId };
  }

  const leadApiClient = deps.leadApiClient ?? new LeadApiClient({}, config);

  // 2. Fetch FRESH lead detail (never act on a stale poll snapshot).
  let detail: LeadDetail;
  try {
    detail = await leadApiClient.getLead(leadId);
  } catch (error) {
    return leadReadFailure(leadId, error, 'lead detail');
  }

  // 3. Re-check the hard eligibility rules against the fresh detail. We reuse
  //    evaluateListEligibility: a SKIPPED outcome means a hard rule failed
  //    (deleted / not-a-lead / blocked status); NEEDS_REVIEW with the
  //    "awaiting_new_lead_rule_confirmation" reason means the hard rules passed
  //    and only the (already-satisfied) auto-eligibility switch held it back;
  //    any other NEEDS_REVIEW reason is an undecidable field and is rejected.
  const row = toListRow(leadId, detail);
  const eligibility = evaluateListEligibility({ row, now: now(), config });
  const hardRulesPassed =
    eligibility.outcome === 'ELIGIBLE' ||
    (eligibility.outcome === 'NEEDS_REVIEW' &&
      eligibility.reason === 'awaiting_new_lead_rule_confirmation');
  if (!hardRulesPassed) {
    // Persist the terminal/retryable decision so the lead does not stay stuck
    // ELIGIBLE. A SKIPPED eligibility outcome is a business no (terminal); a
    // NEEDS_REVIEW outcome is a data gap the re-evaluation sweep can retry.
    await persistEligibleRejection(
      leadId,
      eligibility.outcome === 'SKIPPED' ? ProcessingStatus.SKIPPED : ProcessingStatus.NEEDS_REVIEW,
      eligibility.reason,
      eligibility.detail,
      now(),
    );
    return { outcome: 'rejected_eligibility', leadId, reason: eligibility.reason };
  }

  // 3b. Oct 20 brief routing/ownership gate: phone present, not deleted, not yet
  //     assigned, no booked call, and crm_route not legacy/crm. (The active-hold
  //     check is applied separately at step 5.)
  const crmGate = evaluateCrmGate(row);
  if (!crmGate.ok) {
    // Routing/ownership failures (legacy/crm route, already assigned/booked,
    // no contact number) are terminal business decisions -> SKIPPED.
    await persistEligibleRejection(
      leadId,
      ProcessingStatus.SKIPPED,
      crmGate.reason,
      crmGate.detail,
      now(),
    );
    return { outcome: 'rejected_eligibility', leadId, reason: crmGate.reason };
  }

  // 4. Phone verdict — only a validated E.164 number may be dialled.
  const verdict = readPhoneVerdict(detail.phone);
  if (verdict.status !== 'valid') {
    // invalid = a number that can never be dialled (terminal -> SKIPPED);
    // unreadable = the verdict shape was missing (a data gap the sweep can
    // retry -> NEEDS_REVIEW). Mirrors evaluatePhoneEligibility's mapping.
    if (verdict.status === 'invalid') {
      await persistEligibleRejection(
        leadId,
        ProcessingStatus.SKIPPED,
        'phone_not_validated',
        verdict.detail,
        now(),
      );
    } else {
      await persistEligibleRejection(
        leadId,
        ProcessingStatus.NEEDS_REVIEW,
        'phone_verdict_unreadable',
        verdict.observedKeys.length > 0
          ? `phone verdict keys: ${verdict.observedKeys.slice(0, 12).join(', ')}`
          : 'phone verdict was absent or not an object',
        now(),
      );
    }
    return {
      outcome: 'rejected_phone',
      leadId,
      reason: verdict.status === 'invalid' ? verdict.detail : 'phone verdict unreadable',
    };
  }
  const toNumber = verdict.e164;

  // 5. Caller hold — only call WITHIN an active hold window; never call late.
  const current = detail.current ?? detail.captured ?? {};
  const holdRaw =
    typeof current['caller_hold_until'] === 'string' ? current['caller_hold_until'] : null;
  if (!isHoldActive(evaluateCallWindow(holdRaw, now()))) {
    // The call window is not open. We never extend the hold or dial late. For a
    // first attempt this is terminal (SKIPPED); for a no-answer RETRY it returns
    // to RETRY_PENDING to await a re-issued hold WITHOUT consuming an attempt —
    // finalizeHoldExpired decides from the row.
    await persistHoldExpired(leadId, config, now());
    return { outcome: 'rejected_hold_expired', leadId, reason: 'caller hold is not active' };
  }

  // 6. Person context (best-effort; it enriches the call but never gates it, and
  //    it is NOT sent to Retell yet — see the dynamic-variable note below).
  const personKey =
    detail.personKey ??
    (typeof current['person_key'] === 'string' ? current['person_key'] : undefined);
  let context;
  try {
    const history = personKey ? await leadApiClient.getPerson(personKey) : undefined;
    context = buildLeadCallContext(leadId, detail, history ? { history } : {});
  } catch (error) {
    // History is non-essential; proceed without it rather than block the call.
    logger.warn(
      { leadId, err: errName(error) },
      'person context fetch failed; continuing without history',
    );
    context = buildLeadCallContext(leadId, detail);
  }
  logger.debug(describeContextForLog(context), 'call orchestrator: context prepared');

  // 6b. Re-check the caller hold immediately before committing to a call. The
  //     step-5 hold check can be seconds stale by now — fetching person history
  //     above is a network call that can take time — so a hold that lapsed in the
  //     gap must not be dialled. Re-uses the already-fresh `caller_hold_until` with
  //     the current clock (no new fetch), and returns BEFORE any claim or attempt,
  //     so the lead is left untouched (never stuck mid-call) and is not retried.
  if (!isHoldActive(evaluateCallWindow(holdRaw, now()))) {
    logger.info(
      { leadId },
      'call orchestrator: caller hold lapsed before dialling; not placing a call',
    );
    await persistHoldExpired(leadId, config, now());
    return {
      outcome: 'rejected_hold_expired',
      leadId,
      reason: 'caller hold lapsed before dialling',
    };
  }

  // 7. Claim the ELIGIBLE lead atomically (serialises workers).
  const claimed = await claimEligibleLead(leadId, workerId, now());
  if (!claimed) {
    return { outcome: 'claim_failed', leadId, reason: 'lead not ELIGIBLE or already claimed' };
  }

  // 8. Transition PROCESSING -> CALLING before dialling. Once CALLING,
  //    requeueForRetry refuses the lead, so an uncertain call is never redialled.
  const calling = await markCalling(claimed.id, claimed.version, now());
  if (!calling) {
    return { outcome: 'claim_failed', leadId, reason: 'could not transition to CALLING' };
  }

  // 9. Record the attempt BEFORE invoking Retell. The partial unique index +
  //    this check mean a second active attempt cannot be opened.
  const attempt = await recordCallAttempt(personKey ? { leadId, personKey } : { leadId });
  if (!attempt.created) {
    // An unresolved attempt already exists (e.g. a prior uncertain call).
    logger.warn({ leadId }, 'call orchestrator: active attempt already exists; not dialling');
    return { outcome: 'duplicate_attempt', leadId, callRecordId: attempt.record.id };
  }

  // 10. Place the call. The client also re-checks the switch and validates the
  //     E.164 number; it is single-shot and never retries.
  //     Dynamic variables are the TWO confirmed Travel Call Agent prompt
  //     variables only (customer_name, brand_name); missing values are omitted,
  //     and no other variable is invented. metadata carries only opaque ids.
  const dynamicVariables = buildAgentDynamicVariables(context);
  try {
    const call = await (deps.retellClient ?? new RetellClient({}, config)).createPhoneCall({
      toNumber,
      idempotencyKey: attempt.record.id,
      metadata: { leadId, callRecordId: attempt.record.id },
      ...(Object.keys(dynamicVariables).length > 0 ? { dynamicVariables } : {}),
    });

    await attachProviderCallId(attempt.record.id, call.callId, now());

    logger.info(
      { leadId, callRecordId: attempt.record.id, retellCallId: call.callId },
      'call orchestrator: outbound call initiated',
    );
    return {
      outcome: 'call_initiated',
      leadId,
      callRecordId: attempt.record.id,
      retellCallId: call.callId,
    };
  } catch (error) {
    return handleDialFailure(leadId, attempt.record.id, calling.id, calling.version, error);
  }
}

/**
 * Builds a `LeadListRow`-shaped object from a lead detail response, so the
 * eligibility/CRM-gate logic (written against the list shape) can be re-run
 * against FRESH detail. Exported for reuse by the explicit NEEDS_REVIEW
 * re-evaluation path (`leadReevaluation.service.ts`) - never duplicated.
 */
export function toListRow(leadId: string, detail: LeadDetail): LeadListRow {
  const cur = detail.current ?? detail.captured ?? {};
  return {
    id: leadId,
    updated_at:
      typeof cur['updated_at'] === 'string' ? cur['updated_at'] : new Date(0).toISOString(),
    created_at: cur['created_at'],
    is_deleted: cur['is_deleted'],
    is_lead: cur['is_lead'],
    lead_status: cur['lead_status'],
    caller_hold_until: cur['caller_hold_until'],
    crm_route: cur['crm_route'],
    booked_call: cur['booked_call'],
    sales_agent_email: cur['sales_agent_email'],
    phone: cur['phone'],
    whatsapp: cur['whatsapp'],
    person_key: detail.personKey ?? cur['person_key'],
  } as unknown as LeadListRow;
}

/**
 * Persists an early calling-stage rejection (one that returns BEFORE the lead is
 * claimed) so the row does not stay stuck ELIGIBLE, and emits the per-lead "not
 * called" diagnostic line (leadId + persisted status + reason code + detail).
 *
 * The underlying write is a status-guarded CAS on ELIGIBLE, so if another worker
 * already claimed the lead it is a safe no-op. Best-effort by design: a failure to
 * persist is logged and never thrown, so it can never change the orchestrator's
 * returned outcome or mask the real rejection reason.
 */
async function persistEligibleRejection(
  leadId: string,
  status: typeof ProcessingStatus.SKIPPED | typeof ProcessingStatus.NEEDS_REVIEW,
  reason: string,
  detail: string | undefined,
  now: Date,
): Promise<void> {
  try {
    const applied = await finalizeRejectedEligibleLead(leadId, status, reason, detail, now);
    logger.info(
      {
        leadId,
        persistedStatus: status,
        reason,
        ...(detail === undefined ? {} : { detail }),
        applied,
      },
      'call orchestrator: lead reached the calling stage but was not called; rejection persisted',
    );
    // Record a persistent CRM review-note intent for a freshly-applied NEEDS_REVIEW
    // (the review-note sweep delivers it reliably). A SKIPPED rejection is a terminal
    // business decision and is NOT surfaced here.
    if (applied && status === ProcessingStatus.NEEDS_REVIEW) {
      await enqueueReviewNote(leadId, reason, detail);
    }
  } catch (error) {
    logger.warn(
      { leadId, reason, err: errName(error) },
      'call orchestrator: could not persist calling-stage rejection; lead left unchanged',
    );
  }
}

/**
 * Persists the hold-expired outcome for an ELIGIBLE lead the orchestrator refused
 * because the caller hold is not active. `finalizeHoldExpired` decides, from the
 * row, between RETRY_PENDING (a no-answer retry awaiting a re-issued hold — no
 * attempt consumed) and SKIPPED (a first attempt or an exhausted one). Best-effort:
 * a failure is logged, never thrown, and never changes the returned outcome.
 */
async function persistHoldExpired(leadId: string, config: Env, now: Date): Promise<void> {
  try {
    const nextRetryAt = new Date(now.getTime() + config.LEAD_RETRY_RECHECK_MS);
    const result = await finalizeHoldExpired(
      leadId,
      nextRetryAt,
      config.LEAD_RETRY_MAX_ATTEMPTS,
      now,
    );
    logger.info(
      { leadId, result },
      'call orchestrator: caller hold not active; hold-expired outcome persisted',
    );
  } catch (error) {
    logger.warn(
      { leadId, err: errName(error) },
      'call orchestrator: could not persist hold-expired outcome; lead left unchanged',
    );
  }
}

function leadReadFailure(leadId: string, error: unknown, what: string): OrchestratorResult {
  logger.warn({ leadId, err: errName(error) }, `call orchestrator: ${what} fetch failed`);
  const reason =
    error instanceof LeadApiError ? `${what} fetch failed (${error.kind})` : `${what} fetch failed`;
  return { outcome: 'lead_unavailable', leadId, reason };
}

/**
 * Classifies a Retell failure safely.
 *
 *   - uncertain (timeout / 5xx): the call MAY have been placed. Do NOT mark the
 *     attempt failed and do NOT retry — leave it CALLING for reconciliation.
 *   - permanent (auth / config / invalid destination / 4xx): the call did NOT
 *     happen, so finalise the attempt and processing as FAILED.
 */
async function handleDialFailure(
  leadId: string,
  callRecordId: string,
  processingId: string,
  processingVersion: number,
  error: unknown,
): Promise<OrchestratorResult> {
  const safe = error instanceof RetellApiError ? describeRetellError(error) : { kind: 'unknown' };

  if (error instanceof RetellApiError && error.uncertain) {
    logger.error(
      { leadId, callRecordId, ...safe },
      'call orchestrator: UNCERTAIN provider result; leaving CALLING for reconciliation',
    );
    return { outcome: 'provider_uncertain', leadId, callRecordId, reason: error.kind };
  }

  // Definitely not dialled (pre-flight refusal or a 4xx the provider rejected):
  // safe to finalise as FAILED. We do NOT open another attempt or retry — a
  // confirmed pre-dial rejection is terminal and awaits an explicit retry
  // decision, exactly like any other FAILED lead.
  await completeProcessing(processingId, processingVersion, ProcessingStatus.FAILED, error);
  // Record the failed-before-dialling attempt locally (CallRecord -> FAILED) and
  // as a CRM note. Best-effort: it never changes the outcome and never retries the
  // call; a failure here is logged, not thrown.
  await recordPreDialFailure(leadId, callRecordId, error);
  logger.error(
    { leadId, callRecordId, ...safe },
    'call orchestrator: provider refused before dialling; marked FAILED',
  );
  return {
    outcome: 'provider_failed',
    leadId,
    callRecordId,
    reason: error instanceof RetellApiError ? error.kind : 'unknown',
  };
}

async function recordPreDialFailure(
  leadId: string,
  callRecordId: string,
  error: unknown,
): Promise<void> {
  try {
    const reason = error instanceof RetellApiError ? error.kind : 'provider_refused';
    const record = await markCallAttemptFailed(callRecordId, reason);
    await deliverCallNote(record);
  } catch (noteError) {
    logger.warn(
      { leadId, callRecordId, err: noteError instanceof Error ? noteError.name : 'unknown' },
      'call orchestrator: could not record pre-dial failure note; processing already marked FAILED',
    );
  }
}

function errName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}
