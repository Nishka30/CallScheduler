import { logger } from '../lib/logger.js';
import { CalendarClient } from '../integrations/leadApi/calendar.client.js';
import { LeadApiError, describeLeadApiError } from '../integrations/leadApi/errors.js';

/**
 * Surfaces a `NEEDS_REVIEW` decision to the CRM as a lead NOTE.
 *
 * WHY A NOTE (and not a structured flag): the CRM write API exposes only notes,
 * appointments and lead-forward — there is NO review-flag field and NO
 * update-lead/set-flag/set-status endpoint, and the lead schema carries no review
 * field. So a note (`POST /api/crm/leads/<id>/notes`, via `CalendarClient.postLeadNote`)
 * is the only supported way to tell the RM a lead needs review. The note carries the
 * REAL internal reason code plus a short human explanation — never a generic
 * "Needs review" message.
 *
 * The internal `lead_processing` row stays `NEEDS_REVIEW` regardless: this is a
 * best-effort NOTIFICATION layered on top of the authoritative local decision.
 *
 * Safety model (mirrors `callNoteDelivery.service.ts`):
 *   - SINGLE-SHOT and NEVER THROWS. The CRM's note idempotency is unconfirmed, so a
 *     failed write is logged (leadId + reason, never note content) and NOT retried
 *     in-request — it can never duplicate a note nor flip the internal decision.
 *   - The caller only notifies on the TRANSITION INTO `NEEDS_REVIEW` (a freshly
 *     applied decision), so a lead that merely reappears on a later poll is not
 *     re-noted.
 *
 * FUTURE SEAM: when the CRM adds a structured review flag + update endpoint, replace
 * the `postLeadNote` call here with that write. Callers need not change.
 */

export type NeedsReviewNoteResult = 'sent' | 'failed' | 'skipped';

/**
 * The `NEEDS_REVIEW` reason codes that warrant a CRM review note — the
 * data/CRM-availability gaps an RM can actually act on.
 *
 * Deliberately EXCLUDES `awaiting_new_lead_rule_confirmation`: that reason is not a
 * lead problem at all — it only means automatic calling is switched off by
 * configuration (`LEAD_ELIGIBILITY_AUTO_ENABLED=false`), so there is nothing for the
 * RM to review or correct, and notifying for it would post a note on every new lead.
 * Add it here if the product owner wants those surfaced too.
 */
export const NEEDS_REVIEW_NOTIFY_REASONS = [
  'is_lead_field_absent',
  'lead_status_field_absent',
  'created_at_field_absent',
  'phone_verdict_unreadable',
  'person_key_absent',
  'context_lookup_failed',
  'retry_hold_unavailable',
  'call_unreconciled',
] as const;

/** Short, non-personal explanation per reason code, for the RM reading the note. */
const REASON_EXPLANATIONS: Record<(typeof NEEDS_REVIEW_NOTIFY_REASONS)[number], string> = {
  is_lead_field_absent:
    'The lead record is missing the "is_lead" field, so we cannot confirm this is a real inquiry.',
  lead_status_field_absent: 'The lead record is missing the "lead_status" field.',
  created_at_field_absent:
    'The lead record has no usable "created_at" timestamp, so we cannot confirm it is a new inquiry.',
  phone_verdict_unreadable:
    'The phone-validation result was missing or not in the expected format, so the number could not be confirmed for calling.',
  person_key_absent:
    'The lead has no person_key, so related history could not be retrieved — please check the contact record.',
  context_lookup_failed:
    'A CRM data lookup for this lead failed, so the call context could not be gathered.',
  retry_hold_unavailable:
    'The lead did not answer and no valid caller hold became available to retry within the allowed window. Please re-issue a caller hold if this lead should still be called.',
  call_unreconciled:
    'An outbound call was started but no final result was received within the expected time. The call may or may not have connected — please check the call record before any further action.',
};

export interface NeedsReviewNotifierDeps {
  client?: Pick<CalendarClient, 'postLeadNote'>;
}

/**
 * Posts the CRM review note for a lead that has entered `NEEDS_REVIEW`.
 *
 * Returns `'skipped'` for a reason not in {@link NEEDS_REVIEW_NOTIFY_REASONS}
 * (no CRM write happens), `'sent'` on success, `'failed'` on a (swallowed) error.
 */
export async function notifyNeedsReviewToCrm(
  leadId: string,
  reason: string,
  detail: string | undefined,
  deps: NeedsReviewNotifierDeps = {},
): Promise<NeedsReviewNoteResult> {
  if (!(NEEDS_REVIEW_NOTIFY_REASONS as readonly string[]).includes(reason)) {
    return 'skipped';
  }

  const client = deps.client ?? new CalendarClient();
  const explanation =
    REASON_EXPLANATIONS[reason as (typeof NEEDS_REVIEW_NOTIFY_REASONS)[number]] ??
    'This lead needs review before it can be called.';
  const note =
    `AI Caller: this lead needs review (reason: ${reason}). ${explanation}` +
    (detail ? ` Detail: ${detail}` : '');

  try {
    await client.postLeadNote(leadId, { note });
  } catch (error) {
    const safe =
      error instanceof LeadApiError
        ? describeLeadApiError(error)
        : { kind: 'unknown', err: error instanceof Error ? error.name : 'unknown' };
    // Never log the note content. The internal NEEDS_REVIEW decision is retained.
    logger.warn(
      { leadId, reason, ...safe },
      'CRM needs-review note delivery failed; lead remains NEEDS_REVIEW internally',
    );
    return 'failed';
  }

  logger.info({ leadId, reason }, 'CRM needs-review note delivered');
  return 'sent';
}
