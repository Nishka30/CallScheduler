import { logger } from '../lib/logger.js';
import {
  recordLifecycleEvent,
  listLifecycleEventsByLead,
  listRecentLeadIds,
  listEventsForLeads,
  type RecordLifecycleEventInput,
} from '../repositories/leadLifecycle.repository.js';
import { findByLeadId } from '../repositories/leadProcessing.repository.js';
import {
  getLatestCallRecordByLead,
  listLatestCallRecordsForLeads,
} from '../repositories/callRecord.repository.js';
import {
  findLatestAppointmentForLead,
  listBookedLeadIds,
} from '../repositories/appointmentRecord.repository.js';

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
  /** A consultation was actually booked (AppointmentRecord created). */
  BOOKED: 'booked',
  /** The final status was delivered to Guided Boost (finalization reporting). */
  STATUS_REPORTED: 'status_reported',
  /** The CRM call note was confirmed delivered. */
  CRM_NOTE_DELIVERED: 'crm_note_delivered',
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
  DELIVERED: 'delivered',
  REPORTED: 'reported',
  BOOKED: 'BOOKED',
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
  /** Deterministic lifecycle state derived from the persisted events + call record. */
  currentState: LeadStateCode;
  /** Human-readable label for `currentState`. */
  currentStateLabel: string;
  /** When the state-determining event occurred (ISO), or null. */
  currentStateAt: string | null;
  /** Booking outcome derived from events/call: BOOKED | NO_BOOKING | null. */
  bookingStatus: BookingStatus;
  /** For a stopped/failed/skipped lead: the non-PII reason, else null. */
  stoppedReason: string | null;
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

/** Deterministic high-level lifecycle states for the NEW queue flow. */
export const LeadState = {
  NOT_RECEIVED: 'NOT_RECEIVED',
  RECEIVED: 'RECEIVED',
  RECEIVED_NOT_PROCESSED: 'RECEIVED_NOT_PROCESSED',
  PHONE_INVALID: 'PHONE_INVALID',
  CALL_ATTEMPTED: 'CALL_ATTEMPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  CALL_FAILED: 'CALL_FAILED',
  COMPLETED_NO_BOOKING: 'COMPLETED_NO_BOOKING',
  BOOKED: 'BOOKED',
  STATUS_REPORTED: 'STATUS_REPORTED',
  CRM_NOTE_DELIVERED: 'CRM_NOTE_DELIVERED',
  SKIPPED: 'SKIPPED',
} as const;
export type LeadStateCode = (typeof LeadState)[keyof typeof LeadState];
export type BookingStatus = 'BOOKED' | 'NO_BOOKING' | null;

const STATE_LABELS: Record<LeadStateCode, string> = {
  NOT_RECEIVED: 'Not received by caller',
  RECEIVED: 'Received by caller',
  RECEIVED_NOT_PROCESSED: 'Received — not processed',
  PHONE_INVALID: 'Received — invalid phone',
  CALL_ATTEMPTED: 'Call attempted',
  IN_PROGRESS: 'Call initiated — in progress',
  CALL_FAILED: 'Call failed',
  COMPLETED_NO_BOOKING: 'Completed — no booking',
  BOOKED: 'Booked',
  STATUS_REPORTED: 'Finalized — status reported',
  CRM_NOTE_DELIVERED: 'CRM note delivered',
  SKIPPED: 'Skipped',
};

/** The minimal event/call shape the derivation needs (works on DTOs and rows). */
export interface DerivableEvent {
  event: string;
  status: string | null;
  reason: string | null;
  createdAt: string;
}
export interface DerivableCall {
  status: string;
  outcome: string | null;
}
export interface DerivedLeadState {
  state: LeadStateCode;
  label: string;
  stateAt: string | null;
  bookingStatus: BookingStatus;
  stoppedReason: string | null;
}

const REJECT_STATUSES = new Set(['rejected', 'expired', 'failed']);
function isReject(e: DerivableEvent): boolean {
  return e.event === 'call_failed' || REJECT_STATUSES.has((e.status ?? '').toLowerCase());
}

/**
 * Derives the single accurate lifecycle state from the COMPLETE persisted event
 * history plus the latest call record. Pure and deterministic — this is the
 * source-of-truth replacement for the old "missed/picked" guesswork.
 *
 * Precedence runs from the furthest stage reached (booked/reported) down to the
 * earliest (received), so a lead that progressed and then has a trailing
 * duplicate event still reports its furthest real stage, and a lead that was
 * rejected before dialing reports the rejection — never "missed".
 */
export function deriveLeadLifecycleState(
  events: DerivableEvent[],
  call: DerivableCall | null,
  opts: { hasBooking?: boolean } = {},
): DerivedLeadState {
  const has = (code: string): boolean => events.some((e) => e.event === code);
  const lastOf = (code: string): DerivableEvent | null => {
    for (let i = events.length - 1; i >= 0; i -= 1) if (events[i]!.event === code) return events[i]!;
    return null;
  };
  const at = (e: DerivableEvent | null): string | null => (e ? e.createdAt : null);
  const label = (s: LeadStateCode, stateAt: string | null, booking: BookingStatus, reason: string | null): DerivedLeadState => ({
    state: s,
    label: STATE_LABELS[s],
    stateAt,
    bookingStatus: booking,
    stoppedReason: reason,
  });

  const completed = has(LifecycleEvent.CALL_COMPLETED) || call?.status === 'COMPLETED';
  const booked =
    has(LifecycleEvent.BOOKED) || call?.outcome === 'APPOINTMENT_BOOKED' || opts.hasBooking === true;
  const bookingStatus: BookingStatus = booked ? 'BOOKED' : completed ? 'NO_BOOKING' : null;

  // Furthest-stage-first precedence.
  if (booked) {
    return label(LeadState.BOOKED, at(lastOf(LifecycleEvent.BOOKED)) ?? at(lastOf(LifecycleEvent.CALL_COMPLETED)), 'BOOKED', null);
  }
  if (has(LifecycleEvent.STATUS_REPORTED)) {
    return label(LeadState.STATUS_REPORTED, at(lastOf(LifecycleEvent.STATUS_REPORTED)), bookingStatus, null);
  }
  if (has(LifecycleEvent.CRM_NOTE_DELIVERED)) {
    return label(LeadState.CRM_NOTE_DELIVERED, at(lastOf(LifecycleEvent.CRM_NOTE_DELIVERED)), bookingStatus, null);
  }
  if (completed) {
    return label(LeadState.COMPLETED_NO_BOOKING, at(lastOf(LifecycleEvent.CALL_COMPLETED)), 'NO_BOOKING', null);
  }
  if (has(LifecycleEvent.CALL_FAILED)) {
    const e = lastOf(LifecycleEvent.CALL_FAILED);
    return label(LeadState.CALL_FAILED, at(e), null, e?.reason ?? null);
  }
  if (has(LifecycleEvent.RETELL_INITIATED)) {
    return label(LeadState.IN_PROGRESS, at(lastOf(LifecycleEvent.RETELL_INITIATED)), null, null);
  }
  const attempted = events.some(
    (e) => e.event === LifecycleEvent.CALL_ATTEMPT && (e.status ?? '').toLowerCase() === 'attempted',
  );
  if (attempted) {
    return label(LeadState.CALL_ATTEMPTED, at(lastOf(LifecycleEvent.CALL_ATTEMPT)), null, null);
  }
  // A rejection BEFORE a call was opened: report exactly where it stopped.
  const lastReject = (() => {
    for (let i = events.length - 1; i >= 0; i -= 1) if (isReject(events[i]!)) return events[i]!;
    return null;
  })();
  if (lastReject) {
    if (lastReject.event === LifecycleEvent.PHONE_CHECKED) {
      return label(LeadState.PHONE_INVALID, at(lastReject), null, lastReject.reason ?? null);
    }
    if (lastReject.event === LifecycleEvent.LEAD_DECISION) {
      return label(LeadState.SKIPPED, at(lastReject), null, lastReject.reason ?? null);
    }
    return label(LeadState.RECEIVED_NOT_PROCESSED, at(lastReject), null, lastReject.reason ?? null);
  }
  if (has(LifecycleEvent.LEAD_RECEIVED)) {
    return label(LeadState.RECEIVED, at(lastOf(LifecycleEvent.LEAD_RECEIVED)), null, null);
  }
  // No usable events: fall back to the call record if one exists, else not received.
  if (call) {
    return label(LeadState.IN_PROGRESS, null, bookingStatus, null);
  }
  return label(LeadState.NOT_RECEIVED, null, null, null);
}

/**
 * Aggregates a lead's complete trace: the non-PII processing/call summary plus
 * the chronological lifecycle events. Read-only. Returns `lead: null` with an
 * empty `events` array when nothing is known about the id, so the controller can
 * answer 404.
 */
export async function getLeadLifecycleTrace(leadId: string): Promise<LeadLifecycleTrace> {
  const [processing, rawEvents, latestCall, appointment] = await Promise.all([
    findByLeadId(leadId),
    listLifecycleEventsByLead(leadId),
    getLatestCallRecordByLead(leadId),
    findLatestAppointmentForLead(leadId),
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

  const derived = deriveLeadLifecycleState(
    events,
    latestCall ? { status: latestCall.status, outcome: latestCall.outcome } : null,
    { hasBooking: appointment !== null },
  );

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
    currentState: derived.state,
    currentStateLabel: derived.label,
    currentStateAt: derived.stateAt,
    bookingStatus: derived.bookingStatus,
    stoppedReason: derived.stoppedReason,
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

/** One row of the lead-lifecycle LIST view (summary only; no transcript). */
export interface LeadListItem {
  leadId: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** Processing status (ProcessingStatus), when a processing row exists. */
  status: string | null;
  currentState: LeadStateCode;
  currentStateLabel: string;
  currentStateAt: string | null;
  bookingStatus: BookingStatus;
  callId: string | null;
  callStatus: string | null;
  lastEvent: string | null;
  lastEventAt: string | null;
  stoppedReason: string | null;
}

/**
 * Lead-lifecycle LIST for the trace UI table: the most-recent leads with their
 * deterministic current state, call + booking status, and last event. Derived
 * entirely from persisted data (events + call record). Read-only; no transcript
 * is loaded. `limit` is bounded to [1, 200].
 */
export async function listLeadLifecycles(limit = 50): Promise<LeadListItem[]> {
  const bounded = Math.max(1, Math.min(Math.trunc(limit) || 50, 200));
  const base = await listRecentLeadIds(bounded);
  const ids = base.map((b) => b.leadId);
  if (ids.length === 0) return [];

  const [events, calls, bookedLeadIds] = await Promise.all([
    listEventsForLeads(ids),
    listLatestCallRecordsForLeads(ids),
    listBookedLeadIds(ids),
  ]);

  const byLead = new Map<string, DerivableEvent[]>();
  for (const e of events) {
    const arr = byLead.get(e.leadId) ?? [];
    arr.push({ event: e.event, status: e.status, reason: e.reason, createdAt: e.createdAt.toISOString() });
    byLead.set(e.leadId, arr);
  }
  const callByLead = new Map(calls.map((c) => [c.leadId, c]));

  return base.map((b) => {
    const evs = byLead.get(b.leadId) ?? [];
    const call = callByLead.get(b.leadId) ?? null;
    const derived = deriveLeadLifecycleState(
      evs,
      call ? { status: call.status, outcome: call.outcome } : null,
      { hasBooking: bookedLeadIds.has(b.leadId) },
    );
    const last = evs.length ? evs[evs.length - 1]! : null;
    return {
      leadId: b.leadId,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
      status: b.status,
      currentState: derived.state,
      currentStateLabel: derived.label,
      currentStateAt: derived.stateAt,
      bookingStatus: derived.bookingStatus,
      callId: call?.retellCallId ?? null,
      callStatus: call?.status ?? null,
      lastEvent: last?.event ?? null,
      lastEventAt: last?.createdAt ?? null,
      stoppedReason: derived.stoppedReason,
    };
  });
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
