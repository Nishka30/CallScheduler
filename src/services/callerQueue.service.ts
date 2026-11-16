import { randomUUID } from 'node:crypto';
import { ProcessingStatus } from '@prisma/client';
import { env, requireRetellCallingEnabled, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { LeadSource } from '../lib/leadSource.js';
import { CallerQueueClient } from '../integrations/guidedBoost/callerQueue.client.js';
import type { QueueLead } from '../integrations/guidedBoost/callerQueue.schemas.js';
import type { LeadDetail } from '../integrations/leadApi/schemas.js';
import { RetellClient } from '../integrations/retell/client.js';
import { readPhoneVerdict } from './leadEligibility.service.js';
import {
  buildLeadCallContext,
  type LeadCallContext,
} from './leadContext.service.js';
import { placeCall, type OrchestratorResult } from './callOrchestrator.service.js';
import {
  claimEligibleLead,
  findByLeadId,
  ingestQueueLeadProcessing,
  markCalling,
} from '../repositories/leadProcessing.repository.js';
import { recordCallAttempt } from '../repositories/callRecord.repository.js';
import { recordLifecycle, LifecycleEvent, LifecycleStatus } from './leadLifecycle.service.js';

/**
 * Guided Boost queue ingestion (Step 3).
 *
 * Consumes `GET /api/caller/queue` and safely turns an offered item into an
 * internal QUEUE-sourced `LeadProcessing` candidate. It reuses the existing
 * technical-safety primitives and deliberately STOPS at the "prepared for the
 * call path" boundary — it does NOT dial (see `prepareBoundaryNote`).
 *
 * Business eligibility is NOT re-checked here: Guided Boost has already decided a
 * queued lead is business-eligible, so the poll-only `crm_route` / ownership gate
 * is intentionally not applied. Technical safety IS retained: the master calling
 * switch, a validated E.164 phone, and idempotent duplicate protection keyed on the
 * unique `leadId`.
 */

export type QueueIngestOutcome =
  /** Master calling switch is off — nothing ingested, nothing prepared. */
  | 'calling_disabled'
  /** Already seen this lead (any existing processing row) — no second candidate. */
  | 'duplicate'
  /** Phone failed the existing E.164 verdict — recorded SKIPPED, never dialled. */
  | 'rejected_phone'
  /** Passed technical safety; ingested ELIGIBLE and ready for the call path. */
  | 'prepared';

export interface QueueIngestResult {
  outcome: QueueIngestOutcome;
  leadId: string;
  reason?: string;
  /** Present on 'prepared': the internal representation for the future call path. */
  queueLead?: QueueLead;
  /** Present on 'prepared': the validated E.164 destination to dial. */
  phoneE164?: string;
  /** Present on 'prepared': whether this call created a fresh processing row. */
  created?: boolean;
}

export interface CallerQueueDeps {
  config?: Env;
  queueClient?: CallerQueueClient;
  retellClient?: RetellClient;
  workerId?: string;
  now?: () => Date;
}

/**
 * Builds the Travel Call Agent call context for a QUEUE lead by REUSING the
 * existing `buildLeadCallContext` — the single source of truth for answer IDs and
 * dynamic-variable mapping — rather than a second context system.
 *
 * It synthesizes the minimal `LeadDetail` the builder reads from the confirmed
 * queue payload (no `getLead`/`getPerson` network reads):
 *   - name  → current.name       → customer_name
 *   - brand → current.brand      → brand_name
 *   - page_slug → current.page_slug → enquired_destination (dynamic, never Nepal)
 *   - time_zone → current.time_zone → customer_timezone*
 *   - answers → the existing answer-ID mapping (preferred_trek, travel_timing, …)
 *   - phone → a minimal valid verdict so the builder resolves the dialable number
 *
 * `summary` is intentionally NOT mapped: the existing context builder does not
 * consume a summary field. Absent fields are simply omitted — nothing invented.
 */
export function buildQueueCallContext(queueLead: QueueLead): LeadCallContext {
  const current: Record<string, unknown> = {};
  if (queueLead.name) current['name'] = queueLead.name;
  if (queueLead.brand) current['brand'] = queueLead.brand;
  if (queueLead.pageSlug) current['page_slug'] = queueLead.pageSlug;
  if (queueLead.timeZone) current['time_zone'] = queueLead.timeZone;

  const detail: LeadDetail = {
    current,
    captured: {},
    answers: queueLead.answers,
    // The builder runs the offered number through `readPhoneVerdict`; a minimal
    // valid verdict reuses that exact path (the number was already validated at
    // ingest and is re-validated by the Retell client before dialling).
    phone: { phone_e164: queueLead.phone, valid: true },
  };

  return buildLeadCallContext(queueLead.leadId, detail);
}

/**
 * STEP 3 BOUNDARY — why ingestion stops before `placeCall`.
 *
 * `placeCall` dials and leaves the lead CALLING, awaiting a terminal Retell
 * webhook. For a QUEUE lead that webhook would run the EXISTING webhook path,
 * which (a) does not report the outcome back to Guided Boost (Step 4) and (b)
 * could schedule a forbidden no-answer RETRY_PENDING (Step 5). Leaving a queue
 * lead ELIGIBLE and enabling the reconciliation ELIGIBLE-backstop would also
 * re-hand it to `initiateCallForLead`, which applies the poll-only `crm_route`
 * gate (Step 5 exclusion). So executing a queue call is unsafe until Steps 4–5.
 * Step 3 therefore ingests + prepares only, and reports the dependency.
 */
export const prepareBoundaryNote =
  'queue lead prepared; dialling deferred to Step 4 (status reporting) + Step 5 (webhook/backstop)';

/**
 * Idempotently ingests one offered queue lead and prepares it for the call path.
 *
 * Does NOT dial. Returns a typed outcome describing where the lead landed.
 */
export async function ingestQueueLead(
  queueLead: QueueLead,
  deps: CallerQueueDeps = {},
): Promise<QueueIngestResult> {
  const config = deps.config ?? env;
  const now = deps.now ?? (() => new Date());
  const leadId = queueLead.leadId;

  // 1. Technical safety: master calling switch. While off, do nothing.
  try {
    requireRetellCallingEnabled(config);
  } catch {
    logger.info({ leadId }, 'caller queue: calling disabled; queue lead not ingested');
    return { outcome: 'calling_disabled', leadId };
  }

  // 2. Idempotent duplicate protection — one LeadProcessing row per leadId.
  //
  //    Any existing row means this lead is already in the workflow, so a repeated
  //    Guided Boost offer must NOT start a second candidate/call. This is a
  //    deliberate, per-state decision grounded in the existing state machine, not
  //    a blanket "a row exists so discard":
  //
  //      - QUEUE active (PROCESSING/CALLING) or pending (ELIGIBLE prepared /
  //        RETRY_PENDING): an attempt is in flight or imminent — a second attempt
  //        would break the one-call guarantee. Skip.
  //      - QUEUE terminal (COMPLETED/FAILED/SKIPPED): our single queue attempt is
  //        already done. David's contract keeps the lead on the queue only until a
  //        FINAL STATUS is reported (Step 4) or the deadline passes, so a repeat
  //        offer here is just "we haven't reported yet" — never a reason to dial
  //        again. Skip. (Reporting the final status, which makes GB stop offering,
  //        is Step 4.)
  //      - POLL active (PROCESSING/CALLING) or pending/retry (PENDING/ELIGIBLE/
  //        NEEDS_REVIEW/RETRY_PENDING): a poll call is in flight, imminent, or
  //        retry-scheduled. MUST block to preserve the one-call guarantee.
  //      - POLL terminal (COMPLETED/FAILED/SKIPPED): the poll path already reached
  //        a terminal decision for this lead. Re-opening it for a QUEUE attempt
  //        would require a terminal -> active transition the state machine
  //        deliberately does not provide (the only re-open paths are NEEDS_REVIEW
  //        -only); synthesising one here would be inventing behaviour. A POLL
  //        COMPLETED lead was also already called, so a queue call would be a
  //        second call to the same person. Skip. (In the queue deployment the poll
  //        worker is disabled, so a pre-existing POLL row is only a cutover-era
  //        artifact — see the Step-3 report.)
  //
  //    In every case the safe, non-inventing outcome is the same: do not create a
  //    new attempt. We never downgrade or re-open the existing row.
  const existing = await findByLeadId(leadId);
  if (existing) {
    logger.info(
      { leadId, status: existing.status, source: existing.source },
      'caller queue: lead already in the workflow; skipping duplicate offer',
    );
    return { outcome: 'duplicate', leadId, reason: 'already_in_workflow' };
  }

  // 3. Technical safety: phone. Reuse the EXISTING E.164 verdict logic (no second
  //    validator) by wrapping the offered number in a minimal verdict. Guided Boost
  //    pre-qualifies business eligibility, but a dialable number is still required.
  const verdict = readPhoneVerdict({ phone_e164: queueLead.phone, valid: true });
  if (verdict.status !== 'valid') {
    await ingestQueueLeadProcessing({
      leadId,
      status: ProcessingStatus.SKIPPED,
      ...(queueLead.offeredAt ? { offeredAt: queueLead.offeredAt } : {}),
      ...(queueLead.callBeforeAt ? { callBeforeAt: queueLead.callBeforeAt } : {}),
      decisionReason: 'phone_not_validated',
      decisionDetail: verdict.status === 'invalid' ? verdict.detail : 'phone verdict unreadable',
      now: now(),
    });
    await recordLifecycle({
      leadId,
      event: LifecycleEvent.LEAD_RECEIVED,
      status: LifecycleStatus.RECEIVED,
      detail: 'Guided Boost queue offer received',
      metadata: { source: LeadSource.QUEUE, isTest: queueLead.isTest },
    });
    await recordLifecycle({
      leadId,
      event: LifecycleEvent.PHONE_CHECKED,
      status: LifecycleStatus.REJECTED,
      reason: 'phone_not_validated',
      detail: 'Queue phone is not a valid E.164 number; not dialled',
    });
    logger.info({ leadId }, 'caller queue: offered lead has an invalid phone; recorded not-attempted');
    return { outcome: 'rejected_phone', leadId, reason: 'phone_not_validated' };
  }

  // 4. Ingest as a callable QUEUE candidate (ELIGIBLE). Idempotent: a concurrent
  //    offer that already created the row yields created=false (treated as duplicate).
  const ingest = await ingestQueueLeadProcessing({
    leadId,
    status: ProcessingStatus.ELIGIBLE,
    ...(queueLead.offeredAt ? { offeredAt: queueLead.offeredAt } : {}),
    ...(queueLead.callBeforeAt ? { callBeforeAt: queueLead.callBeforeAt } : {}),
    now: now(),
  });
  if (!ingest.created) {
    logger.info(
      { leadId, status: ingest.record.status },
      'caller queue: row already existed at ingest; skipping duplicate offer',
    );
    return { outcome: 'duplicate', leadId, reason: 'already_in_workflow' };
  }

  await recordLifecycle({
    leadId,
    event: LifecycleEvent.LEAD_RECEIVED,
    status: LifecycleStatus.RECEIVED,
    detail: 'Guided Boost queue offer received',
    metadata: {
      source: LeadSource.QUEUE,
      isTest: queueLead.isTest,
      callBeforeAt: queueLead.callBeforeAt ? queueLead.callBeforeAt.toISOString() : null,
      offeredAt: queueLead.offeredAt ? queueLead.offeredAt.toISOString() : null,
    },
  });
  await recordLifecycle({
    leadId,
    event: LifecycleEvent.PHONE_CHECKED,
    status: LifecycleStatus.PASSED,
    detail: 'Validated dialable number present',
  });

  logger.info(
    { leadId, callBeforeAt: queueLead.callBeforeAt ? queueLead.callBeforeAt.toISOString() : null },
    `caller queue: ${prepareBoundaryNote}`,
  );
  return {
    outcome: 'prepared',
    leadId,
    queueLead,
    phoneE164: verdict.e164,
    created: ingest.created,
  };
}

/**
 * Dials a PREPARED queue lead through the SHARED `placeCall` primitive.
 *
 * Preconditions are produced by `ingestQueueLead` (outcome 'prepared'): a QUEUE
 * `LeadProcessing` row in ELIGIBLE, a validated E.164 number, and the queue
 * payload for context. This function performs ONLY the same technical-safety
 * bookkeeping the poll orchestrator does between "approved" and "dial" — it runs
 * NO business-eligibility gate (no `crm_route`/ownership check): Guided Boost
 * already qualified the lead. It never calls `initiateCallForLead`, so the
 * poll-only gates can never apply to a queue lead.
 *
 * Steps (all reusing existing machinery):
 *   1. claim ELIGIBLE → PROCESSING (version-CAS; a lost race ⇒ claim_failed, no dial)
 *   2. PROCESSING → CALLING (version-CAS)
 *   3. open the active CallRecord (duplicate-safe; an existing attempt ⇒ no dial)
 *   4. build the call context from the payload
 *   5. placeCall(...) — the client re-checks the master switch + E.164, single-shot
 *
 * `source = QUEUE`, `offeredAt`, and `callBeforeAt` set at ingest are preserved
 * (none of these transitions touch them). Returns the orchestrator's own result
 * type so the outcome vocabulary is shared with the poll path.
 */
export async function dialPreparedQueueLead(
  prepared: { leadId: string; queueLead: QueueLead; phoneE164: string },
  deps: CallerQueueDeps = {},
): Promise<OrchestratorResult> {
  const config = deps.config ?? env;
  const now = deps.now ?? (() => new Date());
  const workerId = deps.workerId ?? `queue-${randomUUID()}`;
  const { leadId, queueLead, phoneE164 } = prepared;

  // 1. Claim the ELIGIBLE queue row (version-CAS). A lost race — another worker or
  //    the (future) backstop already took it — yields null and we do not dial.
  const claimed = await claimEligibleLead(leadId, workerId, now());
  if (!claimed) {
    await recordLifecycle({
      leadId,
      event: LifecycleEvent.CALL_ATTEMPT,
      status: LifecycleStatus.REJECTED,
      reason: 'claim_failed',
      detail: 'Queue lead not ELIGIBLE or already claimed by another worker',
    });
    return { outcome: 'claim_failed', leadId, reason: 'lead not ELIGIBLE or already claimed' };
  }

  // 2. PROCESSING -> CALLING before dialling (version-CAS).
  const calling = await markCalling(claimed.id, claimed.version, now());
  if (!calling) {
    await recordLifecycle({
      leadId,
      event: LifecycleEvent.CALL_ATTEMPT,
      status: LifecycleStatus.REJECTED,
      reason: 'claim_failed',
      detail: 'Could not transition queue lead to CALLING',
    });
    return { outcome: 'claim_failed', leadId, reason: 'could not transition to CALLING' };
  }

  // 3. Open the active attempt record (duplicate-safe). An existing unresolved
  //    attempt means a call is already in flight — never open a second CallRecord.
  const attempt = await recordCallAttempt({ leadId });
  if (!attempt.created) {
    logger.warn({ leadId }, 'caller queue: active attempt already exists; not dialling');
    await recordLifecycle({
      leadId,
      event: LifecycleEvent.CALL_ATTEMPT,
      status: LifecycleStatus.REJECTED,
      reason: 'duplicate_attempt',
      detail: 'An unresolved call attempt already exists',
      metadata: { callRecordId: attempt.record.id },
    });
    return { outcome: 'duplicate_attempt', leadId, callRecordId: attempt.record.id };
  }
  await recordLifecycle({
    leadId,
    event: LifecycleEvent.CALL_ATTEMPT,
    status: LifecycleStatus.ATTEMPTED,
    detail: 'Outbound queue call attempt opened',
    metadata: { callRecordId: attempt.record.id, source: LeadSource.QUEUE },
  });

  // 4. Build context from the payload (reuses the existing builder). 5. Dial.
  const context = buildQueueCallContext(queueLead);
  const retellClient = deps.retellClient ?? new RetellClient({}, config);
  return placeCall({
    leadId,
    toNumber: phoneE164,
    context,
    callRecordId: attempt.record.id,
    processingId: calling.id,
    processingVersion: calling.version,
    retellClient,
    now,
  });
}

export interface CallerQueuePollSummary {
  /** Whether the master switch allowed the cycle to run. */
  enabled: boolean;
  /** Whether a lead was offered on this poll. */
  fetched: boolean;
  /** The ingestion outcome for the offered lead, when one was offered. */
  outcome?: QueueIngestOutcome;
  /** The call outcome when a prepared lead was dialled this cycle. */
  callOutcome?: OrchestratorResult['outcome'];
  leadId?: string;
}

/**
 * One queue poll cycle: fetch → validate → ingest the offered lead (if any).
 *
 * The master switch is checked first so a disabled system performs no external
 * request and no ingestion at all.
 */
export async function runCallerQueuePoll(
  deps: CallerQueueDeps = {},
): Promise<CallerQueuePollSummary> {
  const config = deps.config ?? env;

  try {
    requireRetellCallingEnabled(config);
  } catch {
    logger.debug('caller queue: calling disabled; skipping queue poll');
    return { enabled: false, fetched: false };
  }

  const client = deps.queueClient ?? new CallerQueueClient({}, config);
  const queueLead = await client.fetchQueue();
  if (!queueLead) {
    return { enabled: true, fetched: false };
  }

  const result = await ingestQueueLead(queueLead, deps);

  // Only a freshly PREPARED lead is dialled. duplicate/rejected_phone/
  // calling_disabled stop here (no second claim, no second call).
  if (result.outcome !== 'prepared' || !result.queueLead || result.phoneE164 === undefined) {
    return { enabled: true, fetched: true, outcome: result.outcome, leadId: result.leadId };
  }

  const call = await dialPreparedQueueLead(
    { leadId: result.leadId, queueLead: result.queueLead, phoneE164: result.phoneE164 },
    deps,
  );
  return {
    enabled: true,
    fetched: true,
    outcome: result.outcome,
    callOutcome: call.outcome,
    leadId: result.leadId,
  };
}
