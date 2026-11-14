import { logger } from '../lib/logger.js';
import {
  recordLifecycleEvent,
  listLifecycleEventsByLead,
  type RecordLifecycleEventInput,
} from '../repositories/leadLifecycle.repository.js';
import { findByLeadId } from '../repositories/leadProcessing.repository.js';
import { getLatestCallRecordByLead } from '../repositories/callRecord.repository.js';

/**
 * Lead lifecycle trace.
 *
 * A thin, BEST-EFFORT wrapper the existing flow calls to persist "what happened
 * to this lead" into `lead_lifecycle_events`. It is deliberately decoupled from
 * processing: it never throws, so a history-write failure can never break lead
 * polling, eligibility, a call, or a webhook. Every event is ALSO mirrored to
 * the structured logger, so Render logs and the durable table agree while logs
 * are still around — but the table is the source of truth for the Lead Trace UI.
 *
 * NO personal data is recorded here. `metadata` must carry only non-PII context
 * (routing labels, hold timestamps, boolean flags, provider ids).
 */

/** Stable machine-readable stage codes. One per node of the lifecycle. */
export const LifecycleEvent = {
  /** CallScheduler received the lead from the Guided Boost feed. */
  LEAD_RECEIVED: 'lead_received',
  /** Hard eligibility rules were evaluated (list stage or orchestrator re-check). */
  ELIGIBILITY_CHECKED: 'eligibility_checked',
  /** The dialable-phone verdict was evaluated. */
  PHONE_CHECKED: 'phone_checked',
  /** The routing/ownership (CRM) gate was evaluated. */
  CRM_GATE_CHECKED: 'crm_gate_checked',
  /** The caller-hold window was evaluated. */
  HOLD_CHECKED: 'hold_checked',
  /** The polling-stage processing decision was recorded (a FRESH decision). */
  LEAD_DECISION: 'lead_decision',
  /** The poll saw a lead that was already decided on an earlier cycle. */
  ALREADY_DECIDED: 'already_decided',
  /** The orchestrator exited because outbound calling is disabled. */
  CALLING_DISABLED: 'calling_disabled',
  /** The orchestrator could not fetch fresh lead detail (Lead API read failed). */
  LEAD_UNAVAILABLE: 'lead_unavailable',
  /** An outbound call attempt record was opened. */
  CALL_ATTEMPT: 'call_attempt',
  /** Retell accepted the outbound call request. */
  RETELL_INITIATED: 'retell_initiated',
  /** A call could not be placed / failed. */
  CALL_FAILED: 'call_failed',
  /** A call reached a terminal state (final outcome known). */
  CALL_COMPLETED: 'call_completed',
} as const;

export type LifecycleEventCode = (typeof LifecycleEvent)[keyof typeof LifecycleEvent];

/** Common stage status labels (distinct from ProcessingStatus/CallStatus enums). */
export const LifecycleStatus = {
  RECEIVED: 'RECEIVED',
  PASSED: 'passed',
  REJECTED: 'rejected',
  ACTIVE: 'active',
  EXPIRED: 'expired',
  ATTEMPTED: 'attempted',
  INITIATED: 'INITIATED',
  FAILED: 'FAILED',
} as const;

export interface LifecycleInput extends Omit<RecordLifecycleEventInput, 'event'> {
  event: LifecycleEventCode;
}

/**
 * Persists one lifecycle event. Never throws.
 *
 * Returns true when the row was written, false when the write failed (already
 * logged). Callers may ignore the result; it exists for tests and callers that
 * want to know.
 */
export async function recordLifecycle(input: LifecycleInput): Promise<boolean> {
  // Mirror to the structured logger first, so the event is visible even if the
  // DB write below fails. The logger redacts PII paths defensively.
  logger.info(
    {
      lifecycle: true,
      leadId: input.leadId,
      event: input.event,
      status: input.status ?? undefined,
      reason: input.reason ?? undefined,
      detail: input.detail ?? undefined,
      metadata: input.metadata ?? undefined,
    },
    `lifecycle: ${input.event}`,
  );

  try {
    await recordLifecycleEvent(input);
    return true;
  } catch (error) {
    // Best effort: the processing/call path must never fail because history
    // could not be written. The mirrored log line above still captured it.
    logger.warn(
      { leadId: input.leadId, event: input.event, err: error instanceof Error ? error.name : 'unknown' },
      'lifecycle: failed to persist event; continuing',
    );
    return false;
  }
}

/** A single lifecycle event as the API exposes it. */
export interface LifecycleEventDto {
  id: string;
  event: string;
  status: string | null;
  reason: string | null;
  detail: string | null;
  metadata: unknown;
  createdAt: string;
}

/** Non-PII summary of a lead's processing/call state for the trace header. */
export interface LeadTraceSummary {
  leadId: string;
  /** Latest processing status, or null when no processing row exists yet. */
  status: string | null;
  decisionReason: string | null;
  decisionDetail: string | null;
  attemptCount: number | null;
  decidedAt: string | null;
  nextRetryAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Latest-known routing label, derived from recorded lifecycle metadata. */
  crmRoute: string | null;
  /** Latest-known caller hold expiry (ISO), derived from lifecycle metadata. */
  callerHoldUntil: string | null;
  /** Latest call record summary, when one exists. */
  call: {
    callRecordId: string;
    retellCallId: string | null;
    status: string;
    outcome: string | null;
    startedAt: string | null;
    endedAt: string | null;
  } | null;
}

export interface LeadLifecycleTrace {
  lead: LeadTraceSummary | null;
  events: LifecycleEventDto[];
}

/** Pulls a string field out of an event's metadata object, when present. */
function metaString(metadata: unknown, key: string): string | null {
  if (metadata && typeof metadata === 'object' && key in (metadata as Record<string, unknown>)) {
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/**
 * Aggregates a lead's complete trace: the non-PII processing/call summary plus
 * the chronological lifecycle events. Read-only. Returns `lead: null` with an
 * empty `events` array when nothing is known about the id, so the controller can
 * answer 404.
 */
export async function getLeadLifecycleTrace(leadId: string): Promise<LeadLifecycleTrace> {
  const [processing, rawEvents, latestCall] = await Promise.all([
    findByLeadId(leadId),
    listLifecycleEventsByLead(leadId),
    getLatestCallRecordByLead(leadId),
  ]);

  const events: LifecycleEventDto[] = rawEvents.map((e) => ({
    id: e.id,
    event: e.event,
    status: e.status,
    reason: e.reason,
    detail: e.detail,
    metadata: e.metadata ?? null,
    createdAt: e.createdAt.toISOString(),
  }));

  if (!processing && events.length === 0 && !latestCall) {
    return { lead: null, events: [] };
  }

  // Latest-known routing/hold come from the most recent event that carried them.
  let crmRoute: string | null = null;
  let callerHoldUntil: string | null = null;
  for (const e of events) {
    crmRoute = metaString(e.metadata, 'crmRoute') ?? crmRoute;
    callerHoldUntil = metaString(e.metadata, 'callerHoldUntil') ?? callerHoldUntil;
  }

  const lead: LeadTraceSummary = {
    leadId,
    status: processing?.status ?? null,
    decisionReason: processing?.decisionReason ?? null,
    decisionDetail: processing?.decisionDetail ?? null,
    attemptCount: processing?.attemptCount ?? null,
    decidedAt: processing?.decidedAt ? processing.decidedAt.toISOString() : null,
    nextRetryAt: processing?.nextRetryAt ? processing.nextRetryAt.toISOString() : null,
    createdAt: processing?.createdAt ? processing.createdAt.toISOString() : null,
    updatedAt: processing?.updatedAt ? processing.updatedAt.toISOString() : null,
    crmRoute,
    callerHoldUntil,
    call: latestCall
      ? {
          callRecordId: latestCall.id,
          retellCallId: latestCall.retellCallId,
          status: latestCall.status,
          outcome: latestCall.outcome,
          startedAt: latestCall.startedAt ? latestCall.startedAt.toISOString() : null,
          endedAt: latestCall.endedAt ? latestCall.endedAt.toISOString() : null,
        }
      : null,
  };

  return { lead, events };
}

/**
 * Human-readable remaining-hold label for a `caller_hold_until` ISO timestamp,
 * e.g. `6m 42s` or `expired`. Pure and null-safe; reused by the API and tests.
 */
export function holdRemainingLabel(
  callerHoldUntil: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!callerHoldUntil) return null;
  const until = Date.parse(callerHoldUntil);
  if (Number.isNaN(until)) return null;
  const ms = until - now;
  if (ms <= 0) return 'expired';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
