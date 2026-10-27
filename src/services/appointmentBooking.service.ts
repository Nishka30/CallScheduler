import { logger } from '../lib/logger.js';
import { LeadApiError } from '../integrations/leadApi/errors.js';
import { CalendarClient } from '../integrations/leadApi/calendar.client.js';
import { LeadApiClient } from '../integrations/leadApi/client.js';
import { MEETING_TYPES, type MeetingType } from '../integrations/leadApi/calendar.schemas.js';
import { recordAppointment } from '../repositories/appointmentRecord.repository.js';
import type { OfferedSlot } from './teamScheduling.service.js';

/**
 * Books one call through `POST /api/crm/appointments/team` (Oct 20 brief), after
 * re-checking the brief's rules. The team endpoint applies owner-first routing
 * and rotation, and server-side does the rest: assignment to the previous-owner
 * fields, the lead note, the confirmation emails + calendar invite, and
 * cancelling the legacy forward. So this service NEVER assigns a lead, changes
 * status, posts a note, or sends an email on a successful booking.
 */

export type BookingOutcome =
  | 'booked'
  | 'rejected_not_agreed'
  | 'routing_none'
  | 'no_slots'
  | 'invalid_meeting_type'
  | 'invalid_timezone'
  | 'slot_not_offered'
  | 'slot_conflict'
  | 'write_scope_disabled'
  | 'uncertain'
  | 'failed';

export interface BookingResult {
  outcome: BookingOutcome;
  appointmentId?: string;
  /** From the API's `agent.name`, to read back to the customer. */
  agentName?: string;
  reason?: string;
}

export interface BookingRequest {
  leadId: string;
  /** `decision.mode` from the offer; `none` must never be booked. */
  mode: string;
  /** The `starts_at` (UTC) the customer chose — must match an offered slot. */
  chosenStartsAt: string;
  customerTz: string;
  meetingType: MeetingType;
  /** Everything learned on the call (no card/passport/payment data). */
  notes: string;
  /** The customer explicitly agreed to this time, timezone and meeting type. */
  customerAgreed: boolean;
  /** The latest availability actually offered to the customer. */
  offeredSlots: OfferedSlot[];
  /**
   * The lead's person key, used ONLY to reconcile an uncertain booking read-only
   * (the person endpoint carries `appointments[]`). Optional: the reconciler
   * falls back to resolving it from the lead detail.
   */
  personKey?: string;
}

/** A team appointment confirmed to exist upstream during reconciliation. */
export interface MatchedAppointment {
  appointmentId: string;
  startsAt?: string;
  status?: string;
  meetingType?: string;
  agentName?: string;
  agentEmail?: string;
}

export interface ReconcileInput {
  leadId: string;
  /** The UTC `starts_at` we attempted to book. */
  startsAt: string;
  personKey?: string;
}

export interface ReconcileDeps {
  /** Read-only Lead API access (`getLead` for the person key, `getPerson` for appointments). */
  leadApiClient?: Pick<LeadApiClient, 'getLead' | 'getPerson'>;
}

export interface BookingDeps {
  client?: CalendarClient;
  /** Read-only client for reconciling an uncertain booking. */
  leadApiClient?: Pick<LeadApiClient, 'getLead' | 'getPerson'>;
  /** Injectable reconciler (defaults to the read-only `reconcileTeamBooking`). */
  reconcile?: (input: ReconcileInput, deps: ReconcileDeps) => Promise<MatchedAppointment | null>;
}

/**
 * The person endpoint is slow (it can take tens of seconds) — the very reason the
 * write timed out. Reconciliation is a READ, so a timeout is harmless, but it is
 * on an interactive path, so we bound it and never retry-storm. A single, longer
 * attempt than the default is enough to catch the common "write landed, response
 * lost" case.
 */
const RECONCILE_TIMEOUT_MS = 20_000;

function looksLikeIanaTz(tz: string): boolean {
  return tz === 'UTC' || /^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/.test(tz);
}

export async function bookAppointment(
  request: BookingRequest,
  deps: BookingDeps = {},
): Promise<BookingResult> {
  // --- Pre-flight (no API call until all pass) ---
  if (!request.customerAgreed) {
    return { outcome: 'rejected_not_agreed', reason: 'customer did not confirm the slot' };
  }
  if (request.mode === 'none') {
    // Nobody takes the brand's bookings: take details + note instead (no book).
    return { outcome: 'routing_none', reason: 'no agent takes this brand (decision.mode=none)' };
  }
  if (request.offeredSlots.length === 0) {
    return { outcome: 'no_slots', reason: 'no availability was offered' };
  }
  if (!MEETING_TYPES.includes(request.meetingType)) {
    return { outcome: 'invalid_meeting_type', reason: `meeting_type "${request.meetingType}"` };
  }
  if (!request.customerTz || !looksLikeIanaTz(request.customerTz)) {
    return { outcome: 'invalid_timezone', reason: 'customer timezone missing or not IANA' };
  }
  if (!request.offeredSlots.some((s) => s.startsAt === request.chosenStartsAt)) {
    return {
      outcome: 'slot_not_offered',
      reason: 'chosen slot was not in the latest offered availability',
    };
  }

  // --- Book (single-shot; the API routes owner-first / rotation) ---
  const client = deps.client ?? new CalendarClient();
  try {
    const res = await client.bookTeamAppointment({
      leadId: request.leadId,
      startsAt: request.chosenStartsAt,
      meetingType: request.meetingType,
      customerTz: request.customerTz,
      notes: request.notes,
    });

    const appointmentId = res.appointment.id;
    const agentName = res.agent?.name ?? undefined;
    const startsAt = res.appointment.starts_at ?? request.chosenStartsAt;

    await recordAppointment({
      leadId: request.leadId,
      appointmentId,
      ...(res.agent?.email ? { agentEmail: res.agent.email } : {}),
      startsAt: new Date(startsAt),
      ...(res.appointment.status ? { status: res.appointment.status } : {}),
      meetingType: request.meetingType,
      ...(res.decision?.mode ? { decisionMode: res.decision.mode } : {}),
    });

    logger.info(
      { leadId: request.leadId, appointmentId, mode: res.decision?.mode },
      'team appointment booked (assignment, note, emails, forward-cancel handled server-side)',
    );
    return {
      outcome: 'booked',
      appointmentId,
      ...(agentName === undefined ? {} : { agentName }),
    };
  } catch (error) {
    const failure = classifyBookingFailure(error, request.leadId);
    // An uncertain write (timeout/network) MAY have booked upstream. Never
    // resubmit; instead confirm READ-ONLY and only report success if a matching
    // appointment is verified. Otherwise keep the safe "uncertain" response.
    if (failure.outcome === 'uncertain') {
      return reconcileUncertainBooking(request, deps);
    }
    return failure;
  }
}

/** The safe response when a booking's result cannot be confirmed. */
function uncertainResult(): BookingResult {
  return { outcome: 'uncertain', reason: 'booking result unknown; reconciliation required' };
}

/**
 * After an uncertain write, checks READ-ONLY whether a matching appointment now
 * exists upstream. Returns `booked` (and persists the local record) only on a
 * verified match; any miss, error or timeout preserves the safe uncertain result.
 * Never resubmits the booking and never creates or cancels anything.
 */
async function reconcileUncertainBooking(
  request: BookingRequest,
  deps: BookingDeps,
): Promise<BookingResult> {
  const reconcile = deps.reconcile ?? reconcileTeamBooking;
  let matched: MatchedAppointment | null;
  try {
    matched = await reconcile(
      {
        leadId: request.leadId,
        startsAt: request.chosenStartsAt,
        ...(request.personKey === undefined ? {} : { personKey: request.personKey }),
      },
      deps.leadApiClient === undefined ? {} : { leadApiClient: deps.leadApiClient },
    );
  } catch (error) {
    logger.warn(
      { leadId: request.leadId, err: error instanceof Error ? error.name : 'unknown' },
      'booking reconciliation failed; leaving the booking uncertain',
    );
    return uncertainResult();
  }

  if (!matched) return uncertainResult();

  // Verified upstream. Persist locally for idempotency, but a persist failure must
  // NOT flip a real booking back to "uncertain" — the appointment already exists.
  try {
    await recordAppointment({
      leadId: request.leadId,
      appointmentId: matched.appointmentId,
      ...(matched.agentEmail === undefined ? {} : { agentEmail: matched.agentEmail }),
      ...(matched.startsAt === undefined ? {} : { startsAt: new Date(matched.startsAt) }),
      ...(matched.status === undefined ? {} : { status: matched.status }),
      meetingType: request.meetingType,
      decisionMode: request.mode,
    });
  } catch (error) {
    logger.error(
      { leadId: request.leadId, appointmentId: matched.appointmentId, err: errName(error) },
      'reconciled booking confirmed upstream but local persist failed',
    );
  }

  logger.info(
    { leadId: request.leadId, appointmentId: matched.appointmentId },
    'booking reconciled: matching appointment confirmed upstream after an uncertain write',
  );
  return {
    outcome: 'booked',
    appointmentId: matched.appointmentId,
    ...(matched.agentName === undefined ? {} : { agentName: matched.agentName }),
  };
}

/**
 * Read-only reconciliation: looks up the person's `appointments[]` and returns the
 * one that matches this lead + chosen slot + `status: "booked"`, or null.
 *
 * Matching is STRICT to avoid false positives: same `lead_id`, same instant
 * (`starts_at`), and a booked status. Any error (including the slow endpoint
 * timing out again) resolves to null so the caller stays safely "uncertain".
 * Issues only GETs — never a write.
 */
export async function reconcileTeamBooking(
  input: ReconcileInput,
  deps: ReconcileDeps = {},
): Promise<MatchedAppointment | null> {
  const target = Date.parse(input.startsAt);
  if (Number.isNaN(target)) return null;

  const client =
    deps.leadApiClient ?? new LeadApiClient({ timeoutMs: RECONCILE_TIMEOUT_MS, maxRetries: 0 });

  try {
    let personKey = input.personKey;
    if (personKey === undefined) {
      const detail = await client.getLead(input.leadId);
      personKey = detail.personKey ?? undefined;
    }
    if (personKey === undefined) return null;

    const person = await client.getPerson(personKey);
    for (const appt of person.appointments ?? []) {
      if (!appt.id || appt.lead_id !== input.leadId) continue;
      if ((appt.status ?? '').toLowerCase() !== 'booked') continue;
      const at =
        appt.starts_at === null || appt.starts_at === undefined ? NaN : Date.parse(appt.starts_at);
      if (Number.isNaN(at) || at !== target) continue;
      return {
        appointmentId: appt.id,
        ...(appt.starts_at === null || appt.starts_at === undefined
          ? {}
          : { startsAt: appt.starts_at }),
        ...(appt.status === null || appt.status === undefined ? {} : { status: appt.status }),
        ...(appt.meeting_type === null || appt.meeting_type === undefined
          ? {}
          : { meetingType: appt.meeting_type }),
        ...(appt.agent_name === null || appt.agent_name === undefined
          ? {}
          : { agentName: appt.agent_name }),
        ...(appt.agent_email === null || appt.agent_email === undefined
          ? {}
          : { agentEmail: appt.agent_email }),
      };
    }
    return null;
  } catch (error) {
    logger.warn(
      { leadId: input.leadId, err: errName(error) },
      'booking reconciliation read failed; treating as unconfirmed',
    );
    return null;
  }
}

function errName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function classifyBookingFailure(error: unknown, leadId: string): BookingResult {
  if (error instanceof LeadApiError) {
    if (error.status === 409) {
      // Slot taken meanwhile, or nobody takes the brand: refresh slots & offer
      // another. Never retry the same start.
      return { outcome: 'slot_conflict', reason: 'slot no longer available (409)' };
    }
    if (error.status === 403) {
      return { outcome: 'write_scope_disabled', reason: 'appointments scope not enabled (403)' };
    }
    if (error.kind === 'network') {
      // UNCERTAIN: the POST may have booked. Do NOT resubmit — reconcile first.
      logger.error(
        { leadId },
        'team booking uncertain (timeout/network); reconcile before resubmit',
      );
      return { outcome: 'uncertain', reason: 'booking result unknown; reconciliation required' };
    }
    return {
      outcome: 'failed',
      reason: `${error.kind}${error.status ? ` ${String(error.status)}` : ''}`,
    };
  }
  throw error;
}
