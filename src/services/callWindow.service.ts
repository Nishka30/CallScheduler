import { parseTimestamp } from './leadEligibility.service.js';

/**
 * Where a lead sits relative to its caller hold window, per David's revised Lead
 * API contract.
 *
 * `caller_hold_until` is now an OFFICIALLY SUPPORTED field returned on both the
 * collector lead list and the lead detail reads. It is an ISO-8601 timestamp or
 * `null`, and it answers exactly one question: is this lead currently reserved
 * for the AI Caller, or is it already available to the sales team?
 *
 *   - `within_hold`: `caller_hold_until` is in the FUTURE. The hold is active,
 *     reserving this lead for the AI Caller ahead of any human sales agent, so
 *     the AI Caller gets the first opportunity to make contact. The call
 *     workflow may proceed - but ONLY subject to every other eligibility check
 *     (`is_lead`, blocked statuses, phone validation, existing assignment,
 *     person history). The hold is a timing window, never an eligibility
 *     verdict on its own.
 *   - `no_active_hold`: `caller_hold_until` is `null`, absent, already in the
 *     past, or unparsable. There is no live reservation, so the lead is
 *     claimable by the sales team and the AI Caller must NOT initiate a (late)
 *     call. `reason` distinguishes the cases for diagnostics only; all of them
 *     lead to the same do-not-call decision.
 *
 * IMPORTANT - what this field is NOT. `caller_hold_until` reports only whether a
 * hold is active. It NEVER records whether a call has already been attempted or
 * placed. Duplicate-call prevention is a separate concern, tracked per lead id
 * in `callRecord.repository.ts` (`recordCallAttempt`) together with the
 * version-guarded claim in `leadProcessing.repository.ts`. A lead must never be
 * treated as "already called" just because its hold has expired, and must never
 * be re-called just because a hold is active again.
 *
 * Today's configuration. David currently has `CALLER_HOLD_MINUTES = 0` on the
 * Lead API, so `caller_hold_until` comes back `null` for effectively every lead
 * and every lead classifies as `no_active_hold`. When caller testing begins he
 * will raise it to 10 minutes, at which point a freshly created lead carries a
 * ~10-minute future timestamp and classifies as `within_hold`. This function
 * handles both configurations with no code change - it only compares the
 * timestamp the API returns against the current time.
 */
export type CallWindowStatus =
  | { state: 'within_hold'; holdUntil: string; secondsRemaining: number }
  | {
      state: 'no_active_hold';
      reason: 'absent' | 'expired' | 'unparsable';
      /** Present only when the field carried a parsable but past timestamp. */
      holdUntil?: string;
      /** Seconds since the hold lapsed; present only for `reason: 'expired'`. */
      secondsOverdue?: number;
    };

/**
 * Evaluates a lead's position relative to its caller hold window.
 *
 * Pure and side-effect free: it takes the `caller_hold_until` value (as present
 * on a `LeadCallContext` or straight off a Lead API row) and a clock, and
 * returns a classification. It performs no network request and does not depend
 * on the Lead API, Retell, or the database.
 *
 * Accepts `null` as well as `undefined` so the raw API value - which is a string
 * OR `null` - can be passed through directly without the caller first having to
 * normalise it.
 */
export function evaluateCallWindow(
  callerHoldUntil: string | null | undefined,
  now: Date = new Date(),
): CallWindowStatus {
  // Null / absent / empty. With CALLER_HOLD_MINUTES = 0 (today's setting) this
  // is the common case, not an edge case. No hold means the lead is claimable
  // by sales, so the AI Caller does not initiate a call.
  if (!callerHoldUntil) {
    return { state: 'no_active_hold', reason: 'absent' };
  }

  const holdUntil = parseTimestamp(callerHoldUntil);
  if (holdUntil === null) {
    // An unreadable value is treated as "no usable hold" rather than guessed
    // into an active window: the safe direction is to not place a call.
    return { state: 'no_active_hold', reason: 'unparsable' };
  }

  const diffMs = holdUntil.getTime() - now.getTime();

  if (diffMs > 0) {
    return {
      state: 'within_hold',
      holdUntil: callerHoldUntil,
      secondsRemaining: Math.round(diffMs / 1000),
    };
  }

  // Boundary (diffMs === 0) and past: the window is over, the lead has returned
  // to the sales team, and a late AI call must not be placed.
  return {
    state: 'no_active_hold',
    reason: 'expired',
    holdUntil: callerHoldUntil,
    secondsOverdue: Math.round(-diffMs / 1000),
  };
}

/**
 * The single go/no-go the call window answers: may the AI Caller proceed?
 *
 * `true` only inside an active hold. `null`, absent, expired and unparsable
 * values all return `false` - the lead is claimable by sales and must not
 * receive a late AI call. A `true` result is necessary, NOT sufficient: the
 * caller still applies every other eligibility check (and the separate
 * duplicate-attempt guard) before dialling.
 */
export function isHoldActive(status: CallWindowStatus): boolean {
  return status.state === 'within_hold';
}

/**
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DECIDE (deliberately left for Phase 3)
 * ---------------------------------------------------------------------------
 *
 * This module answers "is a hold active right now, so may the AI Caller
 * proceed?" and stops there. The revised contract resolved the two questions an
 * earlier version left open - an expired or null hold now means "do not place a
 * late call" rather than "undecided". What remains for Phase 3:
 *
 * 1. How a caller attempt is reported to END the hold early. The workflow
 *    documentation states that a caller attempt ends the hold early, but names
 *    no endpoint or mechanism for reporting one, and the project rules forbid
 *    inventing CRM endpoints or writes to manage the hold. Phase 3 needs this
 *    confirmed before it can report an attempt; until then a hold simply
 *    expires on its own timer.
 *
 * 2. Whether an active hold should be re-checked immediately before dialling.
 *    Phase 3 is expected to call `evaluateCallWindow()` against FRESH lead
 *    detail fetched right before a call attempt (not a stale earlier poll), so
 *    a hold that lapsed in the interim is caught.
 *
 * Neither of these changes the classification above; they are actions a future
 * caller takes on top of it.
 */
