import { parseTimestamp } from './leadEligibility.service.js';

/**
 * Where a lead sits relative to its caller hold window.
 *
 * This is preparation for Phase 3 (Retell), not an implementation of it.
 * Nothing here places a call, reports a caller attempt, or writes to the CRM -
 * it only answers the timing question a future caller will need answered
 * before it decides what to do.
 *
 *   - `within_hold`: the documented 10-minute privileged window (confirmed
 *     directly by the product owner) is still open. This is when the AI
 *     Caller is supposed to attempt the call, before a human sales agent can
 *     claim the lead through the CRM.
 *   - `hold_expired`: the window has passed. What this SHOULD mean for a
 *     future caller is explicitly NOT decided here - see the note below.
 *   - `no_hold_info`: `callerHoldUntil` was absent or unparsable. Every
 *     sampled Lead API row has had this field `null`, so this is currently
 *     the common case, not an edge case.
 */
export type CallWindowStatus =
  | { state: 'within_hold'; holdUntil: string; secondsRemaining: number }
  | { state: 'hold_expired'; holdUntil: string; secondsOverdue: number }
  | { state: 'no_hold_info' };

/**
 * Evaluates a lead's position relative to its caller hold window.
 *
 * Pure and side-effect free: it takes the `callerHoldUntil` already present on
 * a `LeadCallContext` (see `leadContext.service.ts`) and a clock, and returns a
 * classification. It performs no network request and does not depend on the
 * Lead API, Retell, or the database.
 */
export function evaluateCallWindow(
  callerHoldUntil: string | undefined,
  now: Date = new Date(),
): CallWindowStatus {
  if (!callerHoldUntil) {
    return { state: 'no_hold_info' };
  }

  const holdUntil = parseTimestamp(callerHoldUntil);
  if (holdUntil === null) {
    return { state: 'no_hold_info' };
  }

  const diffMs = holdUntil.getTime() - now.getTime();

  if (diffMs > 0) {
    return {
      state: 'within_hold',
      holdUntil: callerHoldUntil,
      secondsRemaining: Math.round(diffMs / 1000),
    };
  }

  return {
    state: 'hold_expired',
    holdUntil: callerHoldUntil,
    secondsOverdue: Math.round(-diffMs / 1000),
  };
}

/**
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DECIDE (deliberately left for Phase 3)
 * ---------------------------------------------------------------------------
 *
 * This module answers "where is this lead relative to its hold window" and
 * stops there. It deliberately does NOT decide:
 *
 * 1. Whether to still attempt a call once `hold_expired`. The documented
 *    workflow describes the hold as the AI Caller's privileged opportunity,
 *    but never states what happens after it lapses - whether a human agent
 *    may already have claimed the lead by then, or whether the AI Caller may
 *    still call a `hold_expired` lead if no human has acted. That is a
 *    business decision for the product owner, not something to assume here.
 *
 * 2. How a caller attempt is reported to end the hold early. The workflow
 *    documentation states that "a caller attempt ends the hold early," but
 *    names no endpoint or mechanism for reporting one, and the project rules
 *    explicitly forbid inventing CRM endpoints or writes to manage the hold.
 *    Phase 3 needs this confirmed before it can report anything - calling
 *    without ever reporting the attempt would leave the hold to expire
 *    automatically regardless of what this module says.
 *
 * 3. What to do about `no_hold_info`, which is the common case today (every
 *    sampled row had `caller_hold_until` null). It is deliberately NOT treated
 *    as equivalent to `hold_expired` or to `within_hold` - a future caller
 *    must decide its own policy for a lead with no hold information at all,
 *    rather than this module silently picking one for it.
 *
 * Phase 3 is expected to call `evaluateCallWindow()` once it has fetched fresh
 * lead detail immediately before attempting a call (not from a stale, earlier
 * poll), and to make the three decisions above explicitly and separately from
 * this timing calculation.
 */
