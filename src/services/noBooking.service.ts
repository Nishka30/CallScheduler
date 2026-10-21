import { logger } from '../lib/logger.js';
import type { CalendarClient } from '../integrations/leadApi/calendar.client.js';

/**
 * No-booking outcomes (Oct 20 brief §4). Exactly one note per call, and only in
 * the cases the brief names:
 *
 *   - wants_later / gave details -> post ONE note; the legacy forward timer runs.
 *   - declined                   -> post the note AND optionally forward now via
 *                                   the public endpoint (reach legacy immediately).
 *   - no_answer                  -> leave NO note; let the timer forward the lead.
 *
 * Never writes to ActiveCampaign and never changes lead status.
 */

export type NoBookingReason = 'wants_later' | 'declined' | 'no_answer';

export interface NoBookingRequest {
  leadId: string;
  reason: NoBookingReason;
  /** What was learned; required for wants_later/declined, ignored for no_answer. */
  note?: string;
  noteStatus?: string;
  nextFollowup?: string;
  /** Forward a declining lead to the legacy centre now instead of on the timer. */
  forwardNow?: boolean;
}

export type NoBookingAction = 'none' | 'noted' | 'noted_and_forwarded';

export interface NoBookingResult {
  action: NoBookingAction;
}

export async function handleNoBooking(
  request: NoBookingRequest,
  deps: { client: CalendarClient },
): Promise<NoBookingResult> {
  if (request.reason === 'no_answer') {
    // No note; the timer forwards the lead.
    logger.info({ leadId: request.leadId }, 'no-booking: no answer, leaving no note');
    return { action: 'none' };
  }

  if (request.note && request.note.trim().length > 0) {
    await deps.client.postLeadNote(request.leadId, {
      note: request.note,
      ...(request.noteStatus === undefined ? {} : { noteStatus: request.noteStatus }),
      ...(request.nextFollowup === undefined ? {} : { nextFollowup: request.nextFollowup }),
    });
  }

  if (request.reason === 'declined' && request.forwardNow === true) {
    await deps.client.forwardLead(request.leadId);
    return { action: 'noted_and_forwarded' };
  }

  return { action: 'noted' };
}
