import { logger } from '../lib/logger.js';
import { LeadApiError } from '../integrations/leadApi/errors.js';
import { CalendarClient } from '../integrations/leadApi/calendar.client.js';
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
}

export interface BookingDeps {
  client?: CalendarClient;
}

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
    return classifyBookingFailure(error, request.leadId);
  }
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
