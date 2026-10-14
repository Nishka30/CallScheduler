import { CallOutcome, CallStatus } from '@prisma/client';

/**
 * Translates a provider call-result payload into our own `CallStatus` /
 * `CallOutcome` enums.
 *
 * CONTRACT-PENDING. The provider's status / disconnection / analysis vocabulary
 * has NOT been confirmed by David, so no specific field names or values are read
 * here - doing so would be inventing the contract. Until the mapping is
 * confirmed this deliberately returns `UNKNOWN` / `UNKNOWN` for every input.
 *
 * This is a safe default by design: an unmapped (or unexpected) result can only
 * ever leave a call under-classified for human review - never mislabelled as a
 * success, a booking, or a do-not-contact. When David confirms the vocabulary,
 * the only change needed is to fill in the `switch` below (and add a Zod schema
 * for the payload in this folder); callers and storage do not change.
 *
 * Proposed mapping, to confirm (see docs/retell-integration.md §6):
 *   - ended, engaged         -> COMPLETED + INTERESTED / NOT_INTERESTED (analysis)
 *   - booking captured       -> COMPLETED + APPOINTMENT_BOOKED
 *   - voicemail              -> COMPLETED + VOICEMAIL
 *   - no answer / busy       -> NO_ANSWER / BUSY + NOT_REACHED
 *   - wrong / invalid number -> FAILED + WRONG_NUMBER
 *   - anything else          -> UNKNOWN + UNKNOWN   (the current default)
 */
export interface MappedCallResult {
  status: CallStatus;
  outcome: CallOutcome;
}

export function mapRetellResult(_payload: unknown): MappedCallResult {
  // No confirmed field is read from `_payload` yet. Every input maps to UNKNOWN
  // until the provider vocabulary is confirmed; see the proposed table above.
  return { status: CallStatus.UNKNOWN, outcome: CallOutcome.UNKNOWN };
}
