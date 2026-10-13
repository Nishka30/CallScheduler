import { env, type Env } from '../config/env.js';
import type { LeadDetail, LeadListRow } from '../integrations/leadApi/schemas.js';

/**
 * The three ways a lead can be judged.
 *
 * `NEEDS_REVIEW` exists because some of the contract is genuinely unconfirmed.
 * It is the safe landing place for anything we cannot decide on verified
 * fields: such a lead is never auto-called and never silently dropped.
 */
export type EligibilityOutcome = 'ELIGIBLE' | 'SKIPPED' | 'NEEDS_REVIEW';

export interface EligibilityDecision {
  outcome: EligibilityOutcome;
  /** Stable machine-readable code, safe to persist and aggregate. */
  reason: EligibilityReason;
  /** Short non-personal elaboration, safe to log and store. */
  detail?: string;
}

export type EligibilityReason =
  | 'eligible'
  | 'lead_deleted'
  | 'not_a_lead'
  | 'status_blocked'
  | 'known_before_bootstrap'
  | 'phone_not_validated'
  | 'is_lead_field_absent'
  | 'lead_status_field_absent'
  | 'created_at_field_absent'
  | 'phone_verdict_unreadable'
  | 'person_key_absent'
  | 'context_lookup_failed'
  | 'awaiting_new_lead_rule_confirmation';

type EligibilityConfig = Pick<Env, 'LEAD_ELIGIBILITY_AUTO_ENABLED' | 'LEAD_BLOCKED_STATUSES'>;

export interface EligibilityInput {
  row: LeadListRow;
  /**
   * True on the first ever poll, before a durable watermark exists. Everything
   * visible at that moment pre-dates the AI Caller and must not be called.
   */
  isBootstrapRun?: boolean;
  now?: Date;
  config?: EligibilityConfig;
}

/**
 * Column name for the lead status.
 *
 * Grounded in the documented write endpoint `POST /api/crm/leads/<id>/status`,
 * whose body field is `lead_status` and whose effect is "written to the lead".
 */
const LEAD_STATUS_COLUMN = 'lead_status';

/**
 * Column for the "this is a real lead, not a bare visit" flag.
 *
 * CONFIRMED against the live API: present on every list row, and `null` for the
 * overwhelming majority (2280 of 2400 rows sampled over 90 days), which is why
 * this check matters so much.
 */
const IS_LEAD_COLUMN = 'is_lead';

/**
 * Column carrying the inquiry's creation time.
 *
 * CONFIRMED against the live API: a string on every row.
 *
 * Its role here is deliberately narrow: it only has to exist and parse, so we
 * know we are looking at a genuine creation event rather than a malformed
 * record. It is NOT used as an age cutoff (see the note on the removed
 * "newness window" below) - the thing that actually stops an old, merely-
 * updated lead from being treated as new is structural, not a timestamp
 * comparison: `recordLeadDecision` (in the repository layer) only ever
 * transitions a lead out of PENDING once, and the bootstrap run below records
 * every pre-existing lead before polling ever begins. Together those two
 * mean: any lead this function is asked to judge, that was not present at
 * bootstrap and has never been decided before, IS the first time the AI
 * Caller has ever seen it - regardless of how many minutes old `created_at`
 * happens to be by the time a poll run (possibly delayed) picks it up.
 *
 * An additional fixed age cutoff (e.g. "no older than 60 minutes") was tried
 * in an earlier version of this file and removed: it was not supported by the
 * documented workflow, and it actively worked against correctness - a poller
 * that fell behind schedule would wrongly skip genuinely new leads once they
 * crossed the cutoff, even though nothing had decided them yet.
 */
const CREATED_AT_COLUMN = 'created_at';

/**
 * Decides whether a lead from the incremental listing may enter the
 * initial-call workflow.
 *
 * The listing returns new AND changed inquiries - a note, correction,
 * assignment or status change all bump `updated_at` - so appearing in a page is
 * never by itself a reason to call. Every check below either skips on a
 * verified field or defers to NEEDS_REVIEW; nothing becomes ELIGIBLE on a
 * guess.
 *
 * Deliberately NOT checked here: `caller_hold_until`. Per the documented
 * workflow, a hold reserves a new lead FOR the AI Caller - it blocks a human
 * sales agent from claiming it through the CRM for the hold's duration (10
 * minutes, confirmed directly) - so its presence is a reason to call soon, not
 * a reason to skip. An earlier version of this file treated a future
 * `caller_hold_until` as a skip condition, which had the logic backwards. We
 * still cannot confirm that `caller_hold_until` is literally the field that
 * implements this hold - every sampled row had it `null` - so rather than
 * encode an eligibility rule on top of an unconfirmed field mapping, its value
 * is simply carried into the call context (`leadContext.service.ts`) for a
 * future caller to use when timing an attempt, and is not used as a gate here.
 */
export function evaluateListEligibility(input: EligibilityInput): EligibilityDecision {
  const { row } = input;
  const config = input.config ?? env;

  // 1. Deleted inquiries are out, on a documented field.
  if (row.is_deleted === true) {
    return { outcome: 'SKIPPED', reason: 'lead_deleted' };
  }

  // 2. `is_lead` separates a real inquiry from a visit or unvalidated number.
  const isLead = row[IS_LEAD_COLUMN];
  if (isLead === undefined) {
    return {
      outcome: 'NEEDS_REVIEW',
      reason: 'is_lead_field_absent',
      detail: `no "${IS_LEAD_COLUMN}" column in the list row`,
    };
  }
  if (isLead !== true) {
    return {
      outcome: 'SKIPPED',
      reason: 'not_a_lead',
      detail: isLead === null ? 'is_lead is null' : 'is_lead is not true',
    };
  }

  // 3. Statuses that must never receive an initial call.
  //
  // IMPORTANT: a `null` status (2293 of 2400 sampled rows) is NOT treated as a
  // pass-through signal of eligibility - it is simply not one of the three
  // documented excluded statuses (Unsubscribe, Closed, Post Trip), so the
  // exclusion rule does not apply to it. It still has to clear every other
  // gate below (bootstrap, created_at, the master switch, phone validation)
  // before it can ever become ELIGIBLE. Only a MISSING column (`undefined`,
  // the field itself not present) is treated as undecidable, because then we
  // cannot even check whether the lead carries an excluded status.
  //
  // The blocklist is intentionally limited to exactly the three documented
  // statuses. Other statuses observed live but never confirmed as exclusions
  // (`Newsletter`, `Unsubscribe (M)`, `Deleted`, `Cancelled (NR)`, `Dead Lead`)
  // are deliberately NOT added here - doing so would be inventing a business
  // rule, not applying one. `LEAD_BLOCKED_STATUSES` remains configurable if
  // the product owner confirms more exclusions.
  const status = row[LEAD_STATUS_COLUMN];
  if (status === undefined) {
    return {
      outcome: 'NEEDS_REVIEW',
      reason: 'lead_status_field_absent',
      detail: `no "${LEAD_STATUS_COLUMN}" column in the list row`,
    };
  }
  if (typeof status === 'string' && isBlockedStatus(status, config.LEAD_BLOCKED_STATUSES)) {
    return { outcome: 'SKIPPED', reason: 'status_blocked', detail: `status "${status}"` };
  }

  // 4. Leads that already existed when the AI Caller started are not new.
  if (input.isBootstrapRun === true) {
    return { outcome: 'SKIPPED', reason: 'known_before_bootstrap' };
  }

  // 5. `created_at` must exist and parse - see the comment on
  //    CREATED_AT_COLUMN for why this is a presence check, not an age cutoff.
  const createdAtRaw = row[CREATED_AT_COLUMN];
  if (createdAtRaw === undefined || createdAtRaw === null) {
    return {
      outcome: 'NEEDS_REVIEW',
      reason: 'created_at_field_absent',
      detail: `no usable "${CREATED_AT_COLUMN}" column; cannot confirm this is a creation event`,
    };
  }
  if (parseTimestamp(createdAtRaw) === null) {
    return {
      outcome: 'NEEDS_REVIEW',
      reason: 'created_at_field_absent',
      detail: `"${CREATED_AT_COLUMN}" is not a parsable timestamp`,
    };
  }

  // 6. Master safety switch. The field contract is now confirmed, but turning
  //    on automatic calling is the owner's decision, so this stays off until
  //    they enable it explicitly.
  if (!config.LEAD_ELIGIBILITY_AUTO_ENABLED) {
    return {
      outcome: 'NEEDS_REVIEW',
      reason: 'awaiting_new_lead_rule_confirmation',
      detail: 'passed all verified checks; automatic eligibility is disabled by configuration',
    };
  }

  return { outcome: 'ELIGIBLE', reason: 'eligible' };
}

/** Case-insensitive, whitespace-tolerant status blocklist match. */
function isBlockedStatus(status: string, blocked: readonly string[]): boolean {
  const normalized = status.trim().toLowerCase();
  return blocked.some((entry) => entry.trim().toLowerCase() === normalized);
}

/** Parses a value that may be a Lead API timestamp. Exported for reuse by callers that need to interpret `caller_hold_until` without this module treating it as a gate. */
export function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Phone verdict
// ---------------------------------------------------------------------------

export type PhoneVerdict =
  | { status: 'valid'; e164: string; tier?: string; lineType?: string }
  | { status: 'invalid'; detail: string }
  /** The verdict object was absent or did not have the confirmed shape. */
  | { status: 'unreadable'; observedKeys: string[] };

/**
 * Reads the validated phone number from a lead detail response.
 *
 * CONFIRMED shape of `phone` on `GET /api/crm/leads/<id>`:
 *
 *   { phone_raw, phone_e164, phone_best, valid, tier, line_type,
 *     carrier_name, country_iso, lookup_status, checked_at }
 *
 * A number is only callable when `valid === true` AND `phone_e164` is a
 * well-formed E.164 string. In the live data that pairs with
 * `tier: "live_mobile"`, `line_type: "mobile"` and `lookup_status: "ok"`;
 * an unvalidated number shows `valid: null` with `tier: "none"`.
 *
 * `phone_raw` and `phone_best` are deliberately NOT used as a fallback: only
 * the validated E.164 value may ever be dialled.
 *
 * If the object does not carry the confirmed keys the result is `unreadable`,
 * which routes the lead to NEEDS_REVIEW - so a shape change upstream can only
 * ever withhold a call, never cause one.
 */
export function readPhoneVerdict(phone: unknown): PhoneVerdict {
  if (typeof phone !== 'object' || phone === null) {
    return { status: 'unreadable', observedKeys: [] };
  }

  const record = phone as Record<string, unknown>;
  const observedKeys = Object.keys(record);

  // Guard against the upstream shape changing under us.
  if (!('phone_e164' in record) || !('valid' in record)) {
    return { status: 'unreadable', observedKeys };
  }

  const tier = typeof record['tier'] === 'string' ? record['tier'] : undefined;
  const lineType = typeof record['line_type'] === 'string' ? record['line_type'] : undefined;

  if (record['valid'] !== true) {
    return {
      status: 'invalid',
      detail:
        record['valid'] === null
          ? `number not validated (valid=null, tier=${tier ?? 'unknown'})`
          : 'phone verdict reports valid=false',
    };
  }

  const e164 = record['phone_e164'];
  if (typeof e164 !== 'string' || !/^\+[1-9]\d{6,14}$/.test(e164.trim())) {
    return { status: 'invalid', detail: 'valid=true but phone_e164 is missing or malformed' };
  }

  const lookupStatus = record['lookup_status'];
  if (typeof lookupStatus === 'string' && lookupStatus !== 'ok') {
    return { status: 'invalid', detail: `lookup_status is "${lookupStatus}", not "ok"` };
  }

  return {
    status: 'valid',
    e164: e164.trim(),
    ...(tier === undefined ? {} : { tier }),
    ...(lineType === undefined ? {} : { lineType }),
  };
}

/**
 * Second eligibility stage, run against the lead detail response once the list
 * row has passed. A call can only be placed on a verified number.
 */
export function evaluatePhoneEligibility(detail: LeadDetail): EligibilityDecision {
  const verdict = readPhoneVerdict(detail.phone);

  switch (verdict.status) {
    case 'valid':
      return { outcome: 'ELIGIBLE', reason: 'eligible' };
    case 'invalid':
      return { outcome: 'SKIPPED', reason: 'phone_not_validated', detail: verdict.detail };
    case 'unreadable':
      return {
        outcome: 'NEEDS_REVIEW',
        reason: 'phone_verdict_unreadable',
        detail:
          verdict.observedKeys.length > 0
            ? `phone verdict keys: ${verdict.observedKeys.slice(0, 12).join(', ')}`
            : 'phone verdict was absent or not an object',
      };
  }
}
