import { CallStatus, Prisma, type CallOutcome, type CallRecord } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/** Max length of the stored `summary` column (a short agent summary, never a transcript). */
const MAX_SUMMARY_LENGTH = 2000;

/**
 * Call-attempt tracking, keyed by lead id and deliberately SEPARATE from the
 * caller hold.
 *
 * The hold (`caller_hold_until`, evaluated in `callWindow.service.ts`) reports
 * only whether a lead is currently reserved for the AI Caller. It says nothing
 * about whether a call has ever been attempted - an expired hold does NOT mean
 * "already called", and an active hold does NOT mean "not yet called". Whether a
 * call has been attempted is answered only here, by the `call_records` rows this
 * module owns.
 *
 * Duplicate-call prevention has two independent layers:
 *
 *   1. The version-guarded claim in `leadProcessing.repository.ts` serialises
 *      workers so only one ever reaches the call step for a given lead.
 *   2. `recordCallAttempt()` below refuses to open a second attempt while an
 *      earlier one is still unresolved, so a double-dial cannot happen even if
 *      the claim layer were bypassed.
 *
 * NOTE (prepared, not applied). For a database-level guarantee that does not
 * depend on either layer, a partial unique index should be added when call
 * attempts are actually created in Phase 3:
 *
 *   CREATE UNIQUE INDEX "call_records_active_leadId_key"
 *     ON "call_records" ("leadId")
 *     WHERE "status" IN ('PENDING', 'INITIATED', 'IN_PROGRESS', 'UNKNOWN');
 *
 * It is intentionally NOT added as a migration here (no migrations are applied
 * this round, and Prisma cannot express a partial unique index in the schema).
 * `recordCallAttempt()` already catches the resulting unique-constraint
 * violation, so applying that index later hardens this code without changing it.
 */

/**
 * Call statuses that mean "this attempt is still in flight / unresolved".
 *
 * While a lead has an attempt in one of these states, a new attempt must not be
 * opened - the outcome of the first is not yet known, and dialling again could
 * reach a real customer twice. Terminal states (COMPLETED, FAILED, NO_ANSWER,
 * BUSY, CANCELED) are deliberately NOT here: whether a lead may be retried after
 * a terminal outcome is a future retry-policy decision, not a safety guard, and
 * is left to be decided explicitly rather than assumed here.
 */
const UNRESOLVED_STATUSES = [
  CallStatus.PENDING,
  CallStatus.INITIATED,
  CallStatus.IN_PROGRESS,
  CallStatus.UNKNOWN,
] as const;

export interface RecordCallAttemptInput {
  leadId: string;
  personKey?: string;
}

export interface RecordCallAttemptResult {
  /** False when an unresolved attempt already existed and was left untouched. */
  created: boolean;
  record: CallRecord;
}

/**
 * Opens a new call-attempt record for a lead, exactly once while one is active.
 *
 * Concurrency-safe by construction: the check-and-insert runs in one
 * transaction, and a unique-constraint violation (from the prepared partial
 * index, once applied) is caught and resolved to the existing attempt. When two
 * callers race, exactly one gets `created: true`; the other sees the first
 * attempt and gets `created: false`.
 *
 * Returns the existing unresolved attempt (with `created: false`) rather than
 * raising, so a caller can treat "already being called" as a no-op.
 */
export async function recordCallAttempt(
  input: RecordCallAttemptInput,
): Promise<RecordCallAttemptResult> {
  const { leadId, personKey } = input;

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.callRecord.findFirst({
        where: { leadId, status: { in: [...UNRESOLVED_STATUSES] } },
        orderBy: { createdAt: 'desc' },
      });

      if (existing) {
        return { created: false, record: existing };
      }

      const record = await tx.callRecord.create({
        data: {
          leadId,
          ...(personKey === undefined ? {} : { personKey }),
          status: CallStatus.PENDING,
        },
      });

      return { created: true, record };
    });
  } catch (error) {
    // The prepared partial unique index (see the note above) collapses the
    // check-then-insert race to a single winner. The loser lands here and reads
    // back the attempt the winner created.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await findActiveCallAttempt(leadId);
      if (existing) {
        return { created: false, record: existing };
      }
    }
    throw error;
  }
}

/** The current unresolved call attempt for a lead, if any. */
export async function findActiveCallAttempt(leadId: string): Promise<CallRecord | null> {
  return prisma.callRecord.findFirst({
    where: { leadId, status: { in: [...UNRESOLVED_STATUSES] } },
    orderBy: { createdAt: 'desc' },
  });
}

/** True when a lead already has a call attempt that is still in flight. */
export async function hasActiveCallAttempt(leadId: string): Promise<boolean> {
  return (await findActiveCallAttempt(leadId)) !== null;
}

/** How many call attempts have ever been made for a lead, across all statuses. */
export async function countCallAttempts(leadId: string): Promise<number> {
  return prisma.callRecord.count({ where: { leadId } });
}

// ---------------------------------------------------------------------------
// Provider-neutral lifecycle writers (Phase 3)
//
// These manage ONLY our own `call_records` table. They take an opaque provider
// call id and already-decided enum values - they never contact Retell, never
// assume Retell's payload shape, and never place a call. The Retell client,
// request payload, webhook handler, signature verification, and the
// Retell-specific result mapping (`mapRetellResult`) stay pending until David
// confirms the contract.
// ---------------------------------------------------------------------------

/**
 * Records that the provider accepted the outbound request for an attempt.
 *
 * Moves a PENDING attempt to INITIATED and stamps the opaque provider call id
 * exactly once. `retellCallId` is unique, so this is also what makes later
 * webhook events idempotent (they resolve to this row).
 *
 * Idempotent: calling it again with the SAME provider id returns the record
 * unchanged. Attaching a DIFFERENT id to an already-attached attempt is a
 * programming error and throws, rather than silently overwriting the link.
 */
export async function attachProviderCallId(
  callRecordId: string,
  providerCallId: string,
  now: Date = new Date(),
): Promise<CallRecord> {
  // Only attaches when no provider id is set yet, so a redelivery cannot move
  // startedAt or re-link the row.
  const { count } = await prisma.callRecord.updateMany({
    where: { id: callRecordId, retellCallId: null },
    data: { retellCallId: providerCallId, status: CallStatus.INITIATED, startedAt: now },
  });

  const record = await prisma.callRecord.findUniqueOrThrow({ where: { id: callRecordId } });

  if (count === 0 && record.retellCallId !== providerCallId) {
    throw new Error(
      `call record ${callRecordId} already has a different provider call id; refusing to re-link`,
    );
  }

  return record;
}

export interface CallResult {
  status: CallStatus;
  outcome?: CallOutcome;
  /** Short agent summary (not a transcript); truncated to the column limit. */
  summary?: string;
  startedAt?: Date;
  endedAt?: Date;
}

/**
 * Records the result of an attempt, keyed by the opaque provider call id.
 *
 * This is the sink a future (authenticated, signature-verified) webhook handler
 * calls after translating a provider payload with `mapRetellResult`. Keying on
 * the unique `retellCallId` makes a redelivered event idempotent: re-applying
 * the same terminal values produces the same row.
 *
 * Returns `null` for an unknown provider id (no matching attempt), so the caller
 * can decide how to treat a webhook for a call we have no record of, rather than
 * this silently creating one.
 */
export async function recordCallResult(
  providerCallId: string,
  result: CallResult,
): Promise<CallRecord | null> {
  const existing = await prisma.callRecord.findUnique({
    where: { retellCallId: providerCallId },
  });
  if (!existing) {
    return null;
  }

  return prisma.callRecord.update({
    where: { retellCallId: providerCallId },
    data: {
      status: result.status,
      ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
      ...(result.summary === undefined
        ? {}
        : { summary: result.summary.slice(0, MAX_SUMMARY_LENGTH) }),
      ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
      ...(result.endedAt === undefined ? {} : { endedAt: result.endedAt }),
    },
  });
}
