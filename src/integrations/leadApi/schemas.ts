import { z } from 'zod';

/**
 * Defensive schemas for the Lead API read endpoints.
 *
 * Field names marked CONFIRMED were verified against live responses from
 * `https://guided-boost.lovable.app` (read-only GETs, 2400 rows sampled).
 *
 * Rules applied throughout:
 *   * Only fields that are documented or confirmed are typed.
 *   * Everything else is kept as `unknown` extras rather than invented.
 *   * Nothing is coerced into a convenient shape: if the payload does not match
 *     the contract, parsing fails loudly. An unexpected response is never
 *     quietly treated as "no leads".
 */

/** Lead ids appear in paths (`/leads/<id>`, `lead:<id>`); normalise to string. */
export const leadIdSchema = z.union([z.string().min(1), z.number().int()]).transform(String);

/** A timestamp we only ever pass back to the API or compare; kept as a string. */
const timestampSchema = z.string().min(1);

/**
 * One row of `GET /api/crm/leads`.
 *
 * Only `id` and `updated_at` are structurally required - `updated_at` because
 * it is the documented cursor value. Everything else is nullable because the
 * live data shows most columns unset on most rows.
 *
 * CONFIRMED columns on every row: id, created_at, updated_at, brand, page_slug,
 * session_id, visitor_id, person_id, person_uuid, legacy_id, is_lead, name,
 * email, email_original, normalized_email, phone, whatsapp, country,
 * country_code, city, free_text, lead_status, trip_status, sales_agent,
 * sales_agent_email, ac_contact_id, ac_synced_at, email_verified_at,
 * email_verify_result, fbclid, gclid, msclkid, click_id, attribution_source,
 * attribution_touch_at, attribution_evidence, caller_hold_until, person_key,
 * is_deleted, last_edit_at, last_note_at, next_followup.
 *
 * Only the ones the eligibility rules actually read are typed here;
 * `.passthrough()` keeps the rest available without asserting meaning.
 */
export const leadListRowSchema = z
  .object({
    id: leadIdSchema,
    updated_at: timestampSchema,

    /** CONFIRMED present on every row; the new-vs-changed discriminator. */
    created_at: z.string().nullish(),
    /** CONFIRMED; null on the large majority of rows (a visit, not a lead). */
    is_lead: z.boolean().nullish(),
    /** CONFIRMED; often null. Observed values include New Lead, Newsletter,
     *  Unsubscribe, Unsubscribe (M). */
    lead_status: z.string().nullish(),
    /** CONFIRMED present; never populated in the sampled data. */
    caller_hold_until: z.string().nullish(),

    // Oct 20 brief routing/ownership fields (CONFIRMED present; currently null).
    /** `null` = hold running (callable); `legacy` = forwarded; `crm` = call booked. */
    crm_route: z.string().nullish(),
    /** Set once a call is booked for the lead. */
    booked_call: z.unknown().nullish(),
    /** The lead's current sales agent; must be null to be callable. */
    sales_agent_email: z.string().nullish(),
    /** The lead's phone (presence gates eligibility; validated number is on detail). */
    phone: z.unknown().nullish(),
    /**
     * The lead's WhatsApp number. The Himalayan Wonders funnel captures the
     * caller's number here and leaves `phone` null, so the CRM gate treats either
     * field as a present contact number. The dialled E.164 still comes from the
     * detail-level phone verdict, which the Lead API derives from this number.
     */
    whatsapp: z.unknown().nullish(),

    person_key: z.string().min(1).nullish(),
    is_deleted: z.boolean().nullish(),
    last_edit_at: z.string().nullish(),
    last_note_at: z.string().nullish(),
    next_followup: z.string().nullish(),
  })
  .passthrough();

export type LeadListRow = z.infer<typeof leadListRowSchema>;

/**
 * `captured` / `current` are "the row as stored", i.e. raw lead columns whose
 * exact set is not enumerated in the documentation. Typed as an open record so
 * values can be read by confirmed name without asserting the whole shape.
 */
export const leadColumnsSchema = z.record(z.unknown());

/**
 * CONFIRMED shape of the `phone` validation verdict.
 *
 * A number is callable only when `valid === true` and `phone_e164` is
 * well-formed. `phone_raw` / `phone_best` are never dialled.
 *
 * Kept permissive and interpreted by `readPhoneVerdict()`, which treats an
 * unexpected shape as "unreadable" and withholds the call.
 */
export const phoneVerdictSchema = z
  .object({
    phone_raw: z.string().nullish(),
    phone_e164: z.string().nullish(),
    phone_best: z.string().nullish(),
    valid: z.boolean().nullish(),
    /** Observed: `live_mobile` when validated, `none` when not. */
    tier: z.string().nullish(),
    line_type: z.string().nullish(),
    carrier_name: z.string().nullish(),
    country_iso: z.string().nullish(),
    /** Observed: `ok`. */
    lookup_status: z.string().nullish(),
    checked_at: z.string().nullish(),
  })
  .passthrough();

/** CONFIRMED shape of one `answers[]` entry on the lead detail response. */
export const formAnswerSchema = z
  .object({
    questionId: z.string(),
    prompt: z.string(),
    answer: z.string(),
    position: z.number().nullish(),
    answeredAt: z.string().nullish(),
  })
  .passthrough();

/**
 * `GET /api/crm/leads/<id>`.
 *
 * Documented keys: captured, current, overrides, personKey, answers[], phone,
 * emailVerification, conversions[], registeredValue, notes[], edits[],
 * deliveries[]. The live response also carries `source` and `personUuid`,
 * which `.passthrough()` preserves.
 */
export const leadDetailSchema = z
  .object({
    captured: leadColumnsSchema.nullish(),
    current: leadColumnsSchema.nullish(),
    overrides: z.record(z.unknown()).nullish(),
    personKey: z.string().min(1).nullish(),
    answers: z.array(z.unknown()).nullish(),
    phone: z.unknown(),
    emailVerification: z.unknown(),
    conversions: z.array(z.unknown()).nullish(),
    registeredValue: z.unknown(),
    notes: z.array(z.unknown()).nullish(),
    edits: z.array(z.unknown()).nullish(),
    deliveries: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type LeadDetail = z.infer<typeof leadDetailSchema>;

/**
 * `GET /api/crm/persons/<personKey>`.
 *
 * Documented keys: profile, leads[], bookings[], notes[], edits[]. The live
 * response also carries personKey, person, legacyBookings, invoices,
 * statusHistory, acContacts and emailThreads.
 *
 * CONFIRMED `profile` keys: identity, counts, money, salesAgent, leadStatus,
 * tripStatus, source, timeline, freeText, latestActivityAt, legacy,
 * paymentRecords. `counts` carries pageViews, inquiries, emailsSent,
 * mailboxMessages, emailOpens, emailClicks, calls, texts and payments.
 */
export const personHistorySchema = z
  .object({
    profile: z.record(z.unknown()).nullish(),
    leads: z.array(z.unknown()).nullish(),
    bookings: z.array(z.unknown()).nullish(),
    notes: z.array(z.unknown()).nullish(),
    edits: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type PersonHistory = z.infer<typeof personHistorySchema>;

/** The error body the documentation specifies for 4xx/5xx responses. */
export const apiErrorBodySchema = z.object({ error: z.string() }).passthrough();

export interface LeadListPage {
  rows: LeadListRow[];
  /** Exactly the value the API returned; non-null means another page exists. */
  nextCursor: string | null;
  /** True when the response carried no `nextCursor` key at all. */
  nextCursorAbsent: boolean;
  /** Which top-level key held the rows, for diagnostics. */
  rowsKey: string;
}

/**
 * Raised when a response does not match the documented contract. Carries only
 * structural information (key names, counts) - never field values, which can
 * contain personal data.
 */
export class LeadApiContractError extends Error {
  readonly observedKeys: string[];

  constructor(message: string, observedKeys: string[] = []) {
    super(message);
    this.name = 'LeadApiContractError';
    this.observedKeys = observedKeys;
  }
}

/**
 * Locates the array of lead rows in a list response.
 *
 * The documentation describes the rows and `nextCursor` but never names the key
 * that holds the array. Rather than guessing a name, we require the response to
 * contain exactly one top-level array and use that. Zero or several arrays is
 * ambiguous, so we fail with the observed key names instead of risking silently
 * reading the wrong collection.
 *
 * A bare top-level array is also accepted.
 */
export function parseLeadListPage(payload: unknown): LeadListPage {
  if (Array.isArray(payload)) {
    return {
      rows: payload.map((row) => leadListRowSchema.parse(row)),
      nextCursor: null,
      nextCursorAbsent: true,
      rowsKey: '(top-level array)',
    };
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new LeadApiContractError(
      `Lead list response was ${payload === null ? 'null' : typeof payload}, expected an object`,
    );
  }

  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  const arrayKeys = keys.filter((key) => Array.isArray(record[key]));

  if (arrayKeys.length !== 1) {
    throw new LeadApiContractError(
      arrayKeys.length === 0
        ? 'Lead list response contained no array of rows'
        : `Lead list response contained ${String(arrayKeys.length)} top-level arrays, so the rows key is ambiguous`,
      keys,
    );
  }

  const rowsKey = arrayKeys[0]!;
  const rawRows = record[rowsKey] as unknown[];

  const rows = rawRows.map((row, index) => {
    const result = leadListRowSchema.safeParse(row);
    if (!result.success) {
      throw new LeadApiContractError(
        `Lead list row ${String(index)} did not match the documented shape: ${result.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    }
    return result.data;
  });

  const nextCursorAbsent = !('nextCursor' in record);
  const rawCursor = record['nextCursor'];

  if (!nextCursorAbsent && rawCursor !== null && typeof rawCursor !== 'string') {
    throw new LeadApiContractError(
      `nextCursor was ${typeof rawCursor}, expected a string or null`,
      keys,
    );
  }

  return {
    rows,
    nextCursor: typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : null,
    nextCursorAbsent,
    rowsKey,
  };
}
