import { logger } from '../lib/logger.js';
import { verifyRetellSignature } from '../integrations/retell/webhookVerify.js';
import {
  BOOK_FUNCTION,
  GET_SLOTS_FUNCTION,
  bookArgsSchema,
  getSlotsArgsSchema,
  readFunctionArgs,
  retellFunctionRequestSchema,
} from '../integrations/retell/functionSchemas.js';
import { CalendarClient } from '../integrations/leadApi/calendar.client.js';
import { offerTeamSlots, type SlotOffer } from './teamScheduling.service.js';
import {
  bookAppointment,
  type BookingRequest,
  type BookingResult,
} from './appointmentBooking.service.js';
import { buildBookingNote } from './bookingNote.service.js';
import { findByRetellCallId } from '../repositories/callRecord.repository.js';
import { findLatestAppointmentForLead } from '../repositories/appointmentRecord.repository.js';
import type { MeetingType } from '../integrations/leadApi/calendar.schemas.js';

/**
 * Handles Retell booking-tool ("custom function") requests for the Travel Call
 * Agent, HTTP-agnostically (the controller maps the result to a status code).
 *
 * Security model, by construction:
 *   1. The request is authenticated with the SAME signature scheme as the
 *      webhook (`x-retell-signature`, HMAC keyed by the Retell API key), fail
 *      closed. See the note in the controller/README about confirming Retell's
 *      custom-function auth before go-live.
 *   2. The lead is bound SERVER-SIDE: `call.call_id` → the `CallRecord` we
 *      stamped when WE placed the call. A lead id in the model's `args` is never
 *      trusted, so the agent cannot book for an unrelated lead.
 *   3. Booking only proceeds when the agent asserts the customer confirmed, and
 *      the chosen slot is re-validated against FRESH availability.
 *   4. Duplicate/retried invocations are idempotent: an existing appointment for
 *      the lead is returned as-is instead of booking again, and an uncertain
 *      upstream result is never auto-retried or reported as success.
 */

export interface ProcessBookingFunctionInput {
  rawBody: string;
  signature: string | undefined;
  apiKey: string | undefined;
  now?: number;
}

export type BookingFunctionResult =
  | { status: 'misconfigured'; reason: string }
  | { status: 'unauthorized'; reason: string }
  | { status: 'bad_request'; reason: string }
  | { status: 'unknown_call'; reason: string }
  | { status: 'ok'; operation: 'get_slots' | 'book'; payload: Record<string, unknown> };

export interface BookingFunctionDeps {
  verify?: typeof verifyRetellSignature;
  /** Resolves the authoritative lead for a provider call id (server-side binding). */
  findCallByProviderId?: (callId: string) => Promise<{ leadId: string } | null>;
  /** Existing appointment for a lead, for idempotency. */
  findExistingAppointment?: (
    leadId: string,
  ) => Promise<{ appointmentId: string; startsAt: Date | null } | null>;
  offerSlots?: (leadId: string, tz: string) => Promise<SlotOffer>;
  book?: (request: BookingRequest) => Promise<BookingResult>;
}

/** How many slots to offer the agent at once. */
const SLOT_LIMIT = 3;

export async function processBookingFunction(
  input: ProcessBookingFunctionInput,
  deps: BookingFunctionDeps = {},
): Promise<BookingFunctionResult> {
  const verify = deps.verify ?? verifyRetellSignature;

  // 1. Authenticate — fail closed, exactly like the call-lifecycle webhook.
  if (!input.apiKey) {
    return { status: 'misconfigured', reason: 'RETELL_API_KEY not configured for verification' };
  }
  if (!input.signature) {
    return { status: 'unauthorized', reason: 'missing signature header' };
  }
  if (
    !verify(
      input.rawBody,
      input.apiKey,
      input.signature,
      input.now === undefined ? {} : { now: input.now },
    )
  ) {
    return { status: 'unauthorized', reason: 'invalid signature' };
  }

  // 2. Parse the envelope.
  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    return { status: 'bad_request', reason: 'body is not valid JSON' };
  }
  const parsed = retellFunctionRequestSchema.safeParse(json);
  if (!parsed.success) {
    return { status: 'bad_request', reason: 'payload did not match the expected shape' };
  }
  const request = parsed.data;
  const functionName = request.name ?? undefined;

  // 3. Bind the lead SERVER-SIDE from the call id. Never from the args.
  const findCall = deps.findCallByProviderId ?? defaultFindCall;
  const callRecord = await findCall(request.call.call_id);
  if (!callRecord) {
    logger.warn(
      { callId: request.call.call_id, fn: functionName },
      'booking function: no call record for this call id; refusing',
    );
    return { status: 'unknown_call', reason: 'call id is not associated with a known lead' };
  }
  const leadId = callRecord.leadId;

  // Defence in depth: if Retell echoes a lead id in metadata, it must agree.
  const metaLeadId = readMetaLeadId(request.call.metadata);
  if (metaLeadId !== undefined && metaLeadId !== leadId) {
    logger.error(
      { callId: request.call.call_id },
      'booking function: metadata lead id disagrees with the call record; refusing',
    );
    return { status: 'unknown_call', reason: 'lead association mismatch' };
  }

  const args = readFunctionArgs(request);

  if (functionName === GET_SLOTS_FUNCTION) {
    return handleGetSlots(leadId, args, deps);
  }
  if (functionName === BOOK_FUNCTION) {
    return handleBook(leadId, args, deps);
  }
  return { status: 'bad_request', reason: `unsupported function "${functionName ?? '(none)'}"` };
}

async function handleGetSlots(
  leadId: string,
  rawArgs: Record<string, unknown>,
  deps: BookingFunctionDeps,
): Promise<BookingFunctionResult> {
  const args = getSlotsArgsSchema.safeParse(rawArgs);
  if (!args.success) {
    return {
      status: 'ok',
      operation: 'get_slots',
      payload: { available: false, error: 'A timezone is required to look up available times.' },
    };
  }

  const offer = deps.offerSlots
    ? await deps.offerSlots(leadId, args.data.timezone)
    : await offerTeamSlots(leadId, args.data.timezone, new CalendarClient(), { limit: SLOT_LIMIT });

  if (offer.mode === 'none' || offer.slots.length === 0) {
    return {
      status: 'ok',
      operation: 'get_slots',
      payload: {
        available: false,
        reason:
          'No consultant is currently available to book. Take the customer’s details and let them know a consultant will follow up.',
      },
    };
  }

  // Only the times the agent needs — never agent emails or routing internals.
  const slots = offer.slots.slice(0, SLOT_LIMIT).map((s) => ({
    starts_at: s.startsAt,
    ...(s.local === undefined ? {} : { local: s.local }),
  }));
  return { status: 'ok', operation: 'get_slots', payload: { available: true, slots } };
}

async function handleBook(
  leadId: string,
  rawArgs: Record<string, unknown>,
  deps: BookingFunctionDeps,
): Promise<BookingFunctionResult> {
  const parsed = bookArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return bookError('I still need the confirmed destination and a chosen time before I can book.');
  }
  const args = parsed.data;

  // The agent must have confirmed the summary with the customer.
  if (args.confirmed !== true) {
    return bookError('Please confirm the destination and time with the customer before booking.');
  }

  // 4. Idempotency: if this lead is already booked, return that — never rebook.
  const findExisting = deps.findExistingAppointment ?? defaultFindExistingAppointment;
  const existing = await findExisting(leadId);
  if (existing) {
    logger.info(
      { leadId },
      'booking function: appointment already exists; returning it (idempotent)',
    );
    return {
      status: 'ok',
      operation: 'book',
      payload: {
        booked: true,
        already_booked: true,
        appointment_id: existing.appointmentId,
        ...(existing.startsAt ? { starts_at: existing.startsAt.toISOString() } : {}),
      },
    };
  }

  // Re-read FRESH availability: it carries the routing mode and lets us confirm
  // the chosen slot is still open (never trust a stale client-side slot list).
  const offer = deps.offerSlots
    ? await deps.offerSlots(leadId, args.timezone)
    : await offerTeamSlots(leadId, args.timezone, new CalendarClient(), { limit: 20 });

  const note = buildBookingNote({
    confirmedDestination: args.confirmed_destination,
    ...(args.preferred_trek === undefined ? {} : { preferredTrek: args.preferred_trek }),
    ...(args.trip_duration === undefined ? {} : { tripDuration: args.trip_duration }),
    ...(args.group_size === undefined ? {} : { groupSize: args.group_size }),
    ...(args.travel_timing === undefined ? {} : { travelTiming: args.travel_timing }),
    ...(args.special_requirements === undefined
      ? {}
      : { specialRequirements: args.special_requirements }),
    ...(args.destination_changed_from === undefined
      ? {}
      : { changedFromDestination: args.destination_changed_from }),
  });

  const meetingType: MeetingType = args.meeting_type ?? 'phone';

  const request: BookingRequest = {
    leadId,
    mode: offer.mode,
    chosenStartsAt: args.starts_at,
    customerTz: args.timezone,
    meetingType,
    notes: note,
    customerAgreed: true,
    offeredSlots: offer.slots,
  };

  const result = deps.book ? await deps.book(request) : await bookAppointment(request);
  return mapBookingResult(leadId, result);
}

function mapBookingResult(leadId: string, result: BookingResult): BookingFunctionResult {
  switch (result.outcome) {
    case 'booked':
      return {
        status: 'ok',
        operation: 'book',
        payload: {
          booked: true,
          ...(result.appointmentId ? { appointment_id: result.appointmentId } : {}),
          ...(result.agentName ? { consultant: result.agentName } : {}),
        },
      };
    case 'slot_conflict':
    case 'slot_not_offered':
    case 'no_slots':
      return bookError(
        'That time is no longer available. Offer the customer another time and try again.',
      );
    case 'routing_none':
      return bookError(
        'No consultant is currently available to book. Take the customer’s details for follow-up instead.',
      );
    case 'rejected_not_agreed':
      return bookError('Please confirm the destination and time with the customer before booking.');
    case 'invalid_timezone':
      return bookError('I need the customer’s timezone in a standard form before I can book.');
    case 'invalid_meeting_type':
      return bookError('That consultation type is not supported.');
    case 'uncertain':
      // Upstream may have booked; do NOT claim success and do NOT rebook.
      logger.error({ leadId }, 'booking function: UNCERTAIN upstream result; needs reconciliation');
      return bookError(
        'The booking is still being confirmed. Tell the customer it is being finalised and that they will get a confirmation shortly; do not try to book again.',
      );
    case 'write_scope_disabled':
      // Never expose the permission detail to the model; log it instead.
      logger.error({ leadId }, 'booking function: appointments write scope disabled (403)');
      return bookError(
        'Booking is temporarily unavailable. Take the customer’s details for follow-up.',
      );
    case 'failed':
    default:
      logger.error({ leadId, reason: result.reason }, 'booking function: upstream booking failed');
      return bookError(
        'I could not complete the booking just now. Take the customer’s details for follow-up.',
      );
  }
}

function bookError(message: string): BookingFunctionResult {
  return { status: 'ok', operation: 'book', payload: { booked: false, reason: message } };
}

function readMetaLeadId(metadata: Record<string, unknown> | null | undefined): string | undefined {
  if (!metadata) return undefined;
  const value = metadata['leadId'] ?? metadata['lead_id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function defaultFindCall(callId: string): Promise<{ leadId: string } | null> {
  const record = await findByRetellCallId(callId);
  return record ? { leadId: record.leadId } : null;
}

async function defaultFindExistingAppointment(
  leadId: string,
): Promise<{ appointmentId: string; startsAt: Date | null } | null> {
  const record = await findLatestAppointmentForLead(leadId);
  return record ? { appointmentId: record.appointmentId, startsAt: record.startsAt } : null;
}
