import { z } from 'zod';

/**
 * Typed contract for the Guided Boost caller FINAL-STATUS report
 * (`POST /api/caller/leads/<lead_id>/status`).
 *
 * SOURCE OF TRUTH: David's confirmed written contract (handoff + confirmed
 * answers), chosen deliberately because the `/api/caller/*` routes are not present
 * in the Guided Boost source clone available here. Nothing below is invented
 * beyond that written contract; fields not confirmed there are not sent.
 *
 * Scope note (Step 6): `call_in_progress` is NOT included here. It is a near-
 * deadline extension signal that belongs to a later step, and — per the step's
 * rule — it is not added from the handoff alone while the Guided Boost source
 * does not confirm it as an accepted status.
 */

/** The nine confirmed FINAL statuses (terminal results of one call attempt). */
export const GUIDED_BOOST_FINAL_STATUSES = [
  'booked',
  'reached_no_booking',
  'callback_requested',
  'no_answer',
  'voicemail',
  'wrong_number',
  'do_not_call',
  'call_failed',
  'not_attempted',
] as const;

export type GuidedBoostFinalStatus = (typeof GUIDED_BOOST_FINAL_STATUSES)[number];

export const guidedBoostFinalStatusSchema = z.enum(GUIDED_BOOST_FINAL_STATUSES);

/** True for one of the nine confirmed final statuses. */
export function isGuidedBoostFinalStatus(value: unknown): value is GuidedBoostFinalStatus {
  return (
    typeof value === 'string' &&
    (GUIDED_BOOST_FINAL_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The request body for a final-status report. Minimal, confirmed fields only:
 * the status, and an optional short non-PII reason (e.g. `busy`,
 * `no final result from provider`). Artifact fields (summary/transcript/recording/
 * call id/times) are deliberately NOT sent in this step.
 */
/**
 * The request body for a final-status report.
 *
 * `status` + optional `reason` are always present. The artifact fields are
 * included ONLY when actually available (never fabricated) and use the snake_case
 * names consistent with the rest of David's contract (`lead_id`, `call_before`,
 * `offered_at`, …). David's written contract allows summary, transcript, recording
 * URL, call id and started/ended times on a final status; the EXACT JSON field
 * names are inferred from that snake_case convention (flagged as a contract
 * ambiguity to confirm — see the Step 9 report).
 */
export const finalStatusRequestSchema = z.object({
  status: guidedBoostFinalStatusSchema,
  reason: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).optional(),
  transcript: z.string().min(1).optional(),
  recording_url: z.string().min(1).optional(),
  call_id: z.string().min(1).optional(),
  started_at: z.string().min(1).optional(),
  ended_at: z.string().min(1).optional(),
});

export type FinalStatusRequest = z.infer<typeof finalStatusRequestSchema>;

/**
 * The success response. David's contract returns an acknowledgement; we read only
 * `ok` and tolerate extra fields. A re-send of the SAME final status is safe and
 * also returns ok. A DIFFERENT final status after one was accepted returns HTTP
 * 409 (handled by the client via the status code, not this body).
 */
export const finalStatusResponseSchema = z
  .object({ ok: z.boolean().nullish() })
  .passthrough();

export type FinalStatusResponse = z.infer<typeof finalStatusResponseSchema>;

// ---------------------------------------------------------------------------
// call_in_progress — the near-deadline extension signal (Step 8).
//
// Per David's written contract, this is an INTERMEDIATE status (NOT a final one):
// sent as the call nears `call_before`. Guided Boost may extend the deadline by a
// fixed amount ONCE and returns the updated `call_before`:
//   extension granted:  { ok: true, extended: true,  call_before: "<new time>" }
//   no extension left:   { ok: true, extended: false, call_before: "<same time>" }
// It is deliberately kept out of the FINAL status enum so a final result can never
// be set to `call_in_progress`.
// ---------------------------------------------------------------------------

/** An absolute ISO-8601-ish timestamp Date can parse (shared local copy). */
const isoTimestampField = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a parseable ISO-8601 timestamp');

export const callInProgressRequestSchema = z.object({
  status: z.literal('call_in_progress'),
});

export type CallInProgressRequest = z.infer<typeof callInProgressRequestSchema>;

export const callInProgressResponseSchema = z
  .object({
    ok: z.boolean().nullish(),
    /** Whether Guided Boost granted the (one-time) extension. */
    extended: z.boolean().nullish(),
    /** The authoritative deadline after this call — new if extended, else unchanged. */
    call_before: isoTimestampField.nullish(),
  })
  .passthrough();

export type CallInProgressResponse = z.infer<typeof callInProgressResponseSchema>;
