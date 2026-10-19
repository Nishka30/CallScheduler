import { CallOutcome, CallStatus } from '@prisma/client';
import type { RetellWebhookEvent } from './webhookSchemas.js';

/**
 * Translates a verified Retell webhook event into our own `CallStatus` /
 * `CallOutcome` enums.
 *
 * The provider vocabulary is now CONFIRMED from Retell's official docs and SDK
 * types (retell-sdk v6.2.6):
 *   - `call_status`: registered | not_connected | ongoing | ended | error
 *   - `disconnection_reason`: a fixed enum incl. voicemail_reached, dial_busy,
 *     dial_no_answer, invalid_destination, user_requested_dnc,
 *     user_requested_callback, user_hangup, agent_hangup, error_*, ...
 *   - `call_analysis.in_voicemail`: boolean
 *
 * Two deliberate principles (per the task's §4):
 *
 * 1. **Provider status is separate from business outcome.** A call reaching
 *    `ended` is `COMPLETED` at the telephony level; that says nothing about
 *    whether the customer was interested or booked.
 *
 * 2. **Only unambiguous, authoritative signals become a non-UNKNOWN outcome.**
 *    Voicemail / no-answer / busy / invalid-number / explicit DNC / explicit
 *    callback-request are self-evident from `disconnection_reason`. Everything
 *    else — including a completed human conversation and `call_successful` —
 *    stays `UNKNOWN`. In particular `APPOINTMENT_BOOKED`, `INTERESTED` and
 *    `NOT_INTERESTED` are NEVER inferred here: a booking requires an
 *    authoritative Calendly result (not wired), and interest is not reliably
 *    derivable from `call_successful` or a transcript. Under-classifying a call
 *    for human review is always safer than mislabelling it.
 */
export interface MappedCallResult {
  status: CallStatus;
  outcome: CallOutcome;
}

export function mapRetellResult(event: RetellWebhookEvent): MappedCallResult {
  const name = event.event;
  const call = event.call;
  const reason =
    typeof call.disconnection_reason === 'string' ? call.disconnection_reason : undefined;
  const callStatus = typeof call.call_status === 'string' ? call.call_status : undefined;
  const inVoicemail = call.call_analysis?.in_voicemail === true;

  return {
    status: mapStatus(name, callStatus, reason),
    outcome: mapOutcome(reason, inVoicemail),
  };
}

function mapStatus(
  event: string,
  callStatus: string | undefined,
  reason: string | undefined,
): CallStatus {
  if (event === 'call_started') return CallStatus.IN_PROGRESS;

  // A specific non-reached reason is more informative than the generic status.
  if (reason === 'dial_no_answer') return CallStatus.NO_ANSWER;
  if (reason === 'dial_busy') return CallStatus.BUSY;

  switch (callStatus) {
    case 'ongoing':
      return CallStatus.IN_PROGRESS;
    case 'ended':
      return CallStatus.COMPLETED;
    case 'error':
      return CallStatus.FAILED;
    default:
      // registered / not_connected / anything unexpected: leave for reconciliation.
      return CallStatus.UNKNOWN;
  }
}

function mapOutcome(reason: string | undefined, inVoicemail: boolean): CallOutcome {
  if (reason === 'voicemail_reached' || inVoicemail) return CallOutcome.VOICEMAIL;
  if (reason === 'dial_no_answer') return CallOutcome.NOT_REACHED;
  if (reason === 'dial_busy') return CallOutcome.NOT_REACHED;
  if (reason === 'invalid_destination') return CallOutcome.WRONG_NUMBER;
  if (reason === 'user_requested_dnc') return CallOutcome.DO_NOT_CONTACT;
  if (reason === 'user_requested_callback') return CallOutcome.CALLBACK_REQUESTED;

  // Completed conversations, call_successful, sentiment, etc. are deliberately
  // NOT mapped to a business outcome. Booking/interest need an authoritative
  // source we do not have yet.
  return CallOutcome.UNKNOWN;
}
