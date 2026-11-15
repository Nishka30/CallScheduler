import { CallOutcome, CallStatus, type CallRecord } from '@prisma/client';
import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { isQueueSource } from '../lib/leadSource.js';
import {
  CallerStatusClient,
  type FinalStatusResult,
} from '../integrations/guidedBoost/callerStatus.client.js';
import {
  isGuidedBoostFinalStatus,
  type FinalStatusRequest,
  type GuidedBoostFinalStatus,
} from '../integrations/guidedBoost/callerStatus.schemas.js';
import {
  findByLeadId,
  markStatusReportPending,
  markStatusReportSent,
  markStatusReportFailed,
} from '../repositories/leadProcessing.repository.js';
import { getLatestCallRecordByLead } from '../repositories/callRecord.repository.js';
import { findLatestAppointmentForLead } from '../repositories/appointmentRecord.repository.js';

/**
 * Guided Boost final-status reporting for QUEUE leads (Steps 6, 9).
 *
 * The flow is durable and crash-safe. On a terminal QUEUE call the webhook ENQUEUES
 * a finalization (`enqueueQueueFinalization`): it persists the authoritative mapped
 * status + reason and a short artifact-wait deadline, but SENDS NOTHING. A sweep
 * later DELIVERS the final status (`deliverQueueFinalStatus`), reading the (by then
 * artifact-enriched) CallRecord, so late Retell artifacts are included. The same
 * `deliverQueueFinalStatus` powers the Step 7 retry, so a retry resends the persisted
 * status + current artifacts without re-deriving the outcome.
 *
 * Strictly secondary: nothing here places a call, and a reporting failure is persisted
 * as a retryable state, never surfaced to the webhook. POLL leads are untouched.
 */

/** The final status plus an optional short, non-PII reason. */
export interface MappedStatus {
  status: GuidedBoostFinalStatus;
  reason?: string;
}

/**
 * CENTRALIZED mapping from the existing CallScheduler call result to the Guided
 * Boost final-status vocabulary. Pure and exhaustive over the inputs; it does NOT
 * change any internal outcome semantics.
 *
 * Priority (most authoritative first):
 *   1. a real booking (AppointmentRecord)         -> booked
 *   2. explicit business signals from the outcome -> do_not_call / wrong_number /
 *      callback_requested / voicemail  (these can ride on a COMPLETED call, so they
 *      are checked BEFORE the generic completed case)
 *   3. telephony status                           -> no_answer (incl. busy) / call_failed
 *   4. a completed human call with no other signal-> reached_no_booking
 *   5. canceled: split on whether the call started-> not_attempted / call_failed
 *   6. anything else / no terminal provider result-> call_failed (safe default)
 *
 * NOTE on a known gap: a COMPLETED call with outcome UNKNOWN is reported as
 * `reached_no_booking`. The current system has no authoritative "reached but
 * interested/not-interested" signal (outcomeMap never infers interest), and booking
 * is known only via AppointmentRecord — so `reached_no_booking` is the safest
 * existing signal for a completed, un-booked conversation. No new inference is
 * invented here.
 */
export function mapToGuidedBoostStatus(input: {
  callStatus: CallStatus;
  outcome: CallOutcome | null;
  hasAppointment: boolean;
  startedAt: Date | null;
}): MappedStatus {
  const { callStatus, outcome, hasAppointment, startedAt } = input;

  // 1. A real booking is the most authoritative signal (never inferred from a call).
  if (hasAppointment) return { status: 'booked' };

  // 2. Explicit business outcomes (may accompany a COMPLETED telephony status).
  if (outcome === CallOutcome.DO_NOT_CONTACT) return { status: 'do_not_call' };
  if (outcome === CallOutcome.WRONG_NUMBER) return { status: 'wrong_number' };
  if (outcome === CallOutcome.CALLBACK_REQUESTED) return { status: 'callback_requested' };
  if (outcome === CallOutcome.VOICEMAIL) return { status: 'voicemail' };

  // 3. Telephony status.
  if (callStatus === CallStatus.NO_ANSWER) return { status: 'no_answer' };
  if (callStatus === CallStatus.BUSY) return { status: 'no_answer', reason: 'busy' };
  if (callStatus === CallStatus.FAILED) return { status: 'call_failed' };

  // 5. Canceled: distinguished by whether the call had started (start_timestamp →
  //    startedAt). Before ringing → not_attempted; after it started → call_failed.
  if (callStatus === CallStatus.CANCELED) {
    return startedAt
      ? { status: 'call_failed', reason: 'call canceled after it started' }
      : { status: 'not_attempted', reason: 'canceled before the call started' };
  }

  // 4. A completed human call with no other signal.
  if (callStatus === CallStatus.COMPLETED) return { status: 'reached_no_booking' };

  // 6. No clear terminal result from the provider (UNKNOWN / unexpected).
  return { status: 'call_failed', reason: 'no final result from provider' };
}

export interface GuidedBoostStatusDeps {
  config?: Env;
  statusClient?: CallerStatusClient;
  /** Injected for tests; defaults to the latest CallRecord for the lead. */
  fetchCallRecord?: (leadId: string) => Promise<CallRecord | null>;
  now?: () => Date;
}

export type EnqueueFinalizationResult =
  | { enqueued: false; skipped: 'not_queue' | 'already_finalizing' }
  | { enqueued: true; status: GuidedBoostFinalStatus; waitMs: number };

/**
 * Builds the final-status request from the PERSISTED status/reason and whatever
 * artifacts the CallRecord currently holds. Nothing is fabricated: an absent artifact
 * is simply omitted. Artifacts enrich the report; they never change the status.
 */
export function buildFinalStatusRequest(
  status: GuidedBoostFinalStatus,
  reason: string | null | undefined,
  record: CallRecord | null,
): FinalStatusRequest {
  const req: FinalStatusRequest = { status };
  if (reason) req.reason = reason;
  if (!record) return req;
  if (record.summary) req.summary = record.summary;
  if (record.transcript) req.transcript = record.transcript;
  if (record.recordingUrl) req.recording_url = record.recordingUrl;
  if (record.retellCallId) req.call_id = record.retellCallId;
  if (record.startedAt) req.started_at = record.startedAt.toISOString();
  if (record.endedAt) req.ended_at = record.endedAt.toISOString();
  return req;
}

/**
 * Enqueues a terminal QUEUE call for bounded-wait finalization (called from the
 * webhook). QUEUE-only and idempotent (arms only when no finalization exists yet, so
 * a duplicate terminal webhook is a no-op). Computes + persists the authoritative
 * status/reason now (the mapping is stable; artifacts never change it) and a wait
 * deadline so a sweep can send later with artifacts. SENDS NOTHING here.
 *
 * COMPLETED (connected) calls wait `CALLER_FINALIZE_WAIT_MS` for `call_analyzed`
 * artifacts; non-conversation terminals use a zero wait (finalized next sweep).
 */
export async function enqueueQueueFinalization(
  record: CallRecord,
  deps: GuidedBoostStatusDeps = {},
): Promise<EnqueueFinalizationResult> {
  const config = deps.config ?? env;
  const now = deps.now ?? (() => new Date());
  const leadId = record.leadId;

  // QUEUE-only. A POLL lead keeps its existing CRM-note reporting, untouched.
  const processing = await findByLeadId(leadId);
  if (!processing || !isQueueSource(processing.source)) {
    return { enqueued: false, skipped: 'not_queue' };
  }
  if (processing.statusReportStatus !== null) {
    // Already pending / sent / failed — a duplicate terminal event is a no-op.
    return { enqueued: false, skipped: 'already_finalizing' };
  }

  // Booking is known ONLY via an AppointmentRecord (never inferred from the call).
  const appointment = await findLatestAppointmentForLead(leadId);
  const mapped = mapToGuidedBoostStatus({
    callStatus: record.status,
    outcome: record.outcome,
    hasAppointment: appointment !== null,
    startedAt: record.startedAt,
  });

  // Only a COMPLETED (connected) call produces late artifacts (call_analyzed).
  const waitMs = record.status === CallStatus.COMPLETED ? config.CALLER_FINALIZE_WAIT_MS : 0;
  const nextAttemptAt = new Date(now().getTime() + waitMs);

  const armed = await markStatusReportPending(leadId, mapped.status, mapped.reason, nextAttemptAt);
  if (!armed) {
    // Lost a race to another terminal event; treat as already finalizing.
    return { enqueued: false, skipped: 'already_finalizing' };
  }
  logger.info(
    { leadId, status: mapped.status, waitMs },
    'caller status: queue finalization enqueued (awaiting artifact window)',
  );
  return { enqueued: true, status: mapped.status, waitMs };
}

export interface DeliverResult {
  outcome: FinalStatusResult['outcome'] | 'invalid';
  status: string;
}

/**
 * Delivers (sends) a QUEUE final status with current artifacts. Shared by the
 * finalization sweep (first send) and the Step 7 retry. Uses the PERSISTED
 * `lastFinalStatus`/`reason` — it NEVER re-derives the outcome — and reads artifacts
 * from the latest CallRecord. Persists `sent` on 2xx/409 (409 = a resolved conflict,
 * the first final wins) or `failed` (retryable) on failure. Never throws, never calls
 * a call path.
 */
export async function deliverQueueFinalStatus(
  leadId: string,
  lastFinalStatus: string,
  reason: string | null,
  deps: GuidedBoostStatusDeps = {},
): Promise<DeliverResult> {
  const config = deps.config ?? env;
  const now = deps.now ?? (() => new Date());

  if (!isGuidedBoostFinalStatus(lastFinalStatus)) {
    // An unrecognized persisted status is never sent; mark failed so it is visible.
    const nextAttemptAt = new Date(now().getTime() + config.CALLER_STATUS_RETRY_BACKOFF_MS);
    await safeMarkFailed(leadId, lastFinalStatus, 'invalid_persisted_status', nextAttemptAt);
    return { outcome: 'invalid', status: lastFinalStatus };
  }

  const fetchCallRecord = deps.fetchCallRecord ?? getLatestCallRecordByLead;
  const record = await fetchCallRecord(leadId);
  const request = buildFinalStatusRequest(lastFinalStatus, reason, record);

  const client = deps.statusClient ?? new CallerStatusClient({}, config);
  let result: FinalStatusResult;
  try {
    result = await client.reportFinalStatus(leadId, request);
  } catch (error) {
    const nextAttemptAt = new Date(now().getTime() + config.CALLER_STATUS_RETRY_BACKOFF_MS);
    await safeMarkFailed(leadId, lastFinalStatus, error instanceof Error ? error.message : 'unknown', nextAttemptAt);
    return { outcome: 'failed', status: lastFinalStatus };
  }

  if (result.outcome === 'sent' || result.outcome === 'conflict') {
    await safeMarkSent(leadId, lastFinalStatus, now());
    logger.info(
      { leadId, status: lastFinalStatus, outcome: result.outcome },
      'caller status: final status delivered to Guided Boost',
    );
  } else {
    const nextAttemptAt = new Date(now().getTime() + config.CALLER_STATUS_RETRY_BACKOFF_MS);
    await safeMarkFailed(leadId, lastFinalStatus, result.errorKind ?? 'failed', nextAttemptAt);
    logger.warn(
      { leadId, status: lastFinalStatus, httpStatus: result.httpStatus, kind: result.errorKind },
      'caller status: final status delivery failed; recorded as retryable',
    );
  }
  return { outcome: result.outcome, status: lastFinalStatus };
}

async function safeMarkSent(leadId: string, status: string, now: Date): Promise<void> {
  try {
    await markStatusReportSent(leadId, status, now);
  } catch (error) {
    logger.warn(
      { leadId, err: error instanceof Error ? error.name : 'unknown' },
      'caller status: could not persist sent state; report still delivered',
    );
  }
}

async function safeMarkFailed(
  leadId: string,
  finalStatus: string,
  error: string,
  nextAttemptAt: Date,
): Promise<void> {
  try {
    await markStatusReportFailed(leadId, finalStatus, error, nextAttemptAt);
  } catch (persistError) {
    logger.warn(
      { leadId, err: persistError instanceof Error ? persistError.name : 'unknown' },
      'caller status: could not persist failed state',
    );
  }
}
