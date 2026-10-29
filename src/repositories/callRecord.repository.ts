import { CallOutcome, CallStatus, Prisma, type CallRecord } from '@prisma/client';
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

/**
 * Looks up the call attempt a provider call id belongs to.
 *
 * This is the secure binding between a live Retell call and its lead: we stamped
 * `retellCallId` when WE placed the call (`attachProviderCallId`), so the lead on
 * the returned row is authoritative. A Retell function/tool request is tied to
 * its lead through this lookup on `call.call_id` — never through a lead id the
 * model supplies. `retellCallId` is unique, so this returns at most one row.
 */
export async function findByRetellCallId(providerCallId: string): Promise<CallRecord | null> {
  return prisma.callRecord.findUnique({ where: { retellCallId: providerCallId } });
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

// ---------------------------------------------------------------------------
// Webhook event application (terminal-safe, order-independent, idempotent)
//
// Code-only — no schema change. The existing `call_records` columns already
// carry everything needed; what was missing was merge logic that a redelivered
// or out-of-order webhook cannot use to clobber a more authoritative result.
// ---------------------------------------------------------------------------

/**
 * Status rank for a no-downgrade merge. Higher = more advanced. All terminal
 * states share the top rank (first terminal wins); UNKNOWN sits below PENDING
 * so it can never overwrite a known status.
 */
const STATUS_RANK: Record<CallStatus, number> = {
  [CallStatus.UNKNOWN]: -1,
  [CallStatus.PENDING]: 0,
  [CallStatus.INITIATED]: 1,
  [CallStatus.IN_PROGRESS]: 2,
  [CallStatus.COMPLETED]: 3,
  [CallStatus.FAILED]: 3,
  [CallStatus.NO_ANSWER]: 3,
  [CallStatus.BUSY]: 3,
  [CallStatus.CANCELED]: 3,
};

const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set([
  CallStatus.COMPLETED,
  CallStatus.FAILED,
  CallStatus.NO_ANSWER,
  CallStatus.BUSY,
  CallStatus.CANCELED,
]);

export interface WebhookCallUpdate {
  status: CallStatus;
  outcome?: CallOutcome;
  summary?: string;
  startedAt?: Date;
  endedAt?: Date;
  /** Full transcript text; the fuller version wins (a late `call_analyzed` fills it in). */
  transcript?: string;
  transcriptJson?: Prisma.InputJsonValue;
  analysis?: Prisma.InputJsonValue;
  recordingUrl?: string;
  disconnectionReason?: string;
  direction?: string;
  customerTz?: string;
}

type ExistingCallFields = Pick<
  CallRecord,
  | 'status'
  | 'outcome'
  | 'summary'
  | 'startedAt'
  | 'endedAt'
  | 'transcript'
  | 'transcriptJson'
  | 'analysis'
  | 'recordingUrl'
  | 'disconnectionReason'
  | 'direction'
  | 'customerTz'
>;

/**
 * Computes the SAFE subset of an incoming webhook update to apply over an
 * existing record. Pure and side-effect free, so every merge rule is unit
 * tested without a database.
 *
 * Rules (each field moves only in the safe direction, making the result
 * independent of delivery order and idempotent under redelivery):
 *
 *   - status: never downgrades, never overwrites a terminal state, and is never
 *     replaced by UNKNOWN. A later `call_started` cannot undo a `call_ended`.
 *   - outcome: only fills in from null/UNKNOWN to a known value, so a late
 *     `call_ended` (UNKNOWN) cannot erase the outcome a `call_analyzed` set.
 *   - summary / startedAt / endedAt: written once (when currently empty), never
 *     clobbered by a redelivery.
 */
export function computeSafeCallUpdate(
  existing: ExistingCallFields,
  incoming: WebhookCallUpdate,
): Prisma.CallRecordUpdateInput {
  const data: Prisma.CallRecordUpdateInput = {};

  if (
    incoming.status !== CallStatus.UNKNOWN &&
    !TERMINAL_STATUSES.has(existing.status) &&
    STATUS_RANK[incoming.status] > STATUS_RANK[existing.status]
  ) {
    data.status = incoming.status;
  }

  if (
    incoming.outcome !== undefined &&
    incoming.outcome !== CallOutcome.UNKNOWN &&
    (existing.outcome === null || existing.outcome === CallOutcome.UNKNOWN)
  ) {
    data.outcome = incoming.outcome;
  }

  if (incoming.summary !== undefined && incoming.summary.length > 0 && existing.summary === null) {
    data.summary = incoming.summary.slice(0, MAX_SUMMARY_LENGTH);
  }

  if (incoming.startedAt !== undefined && existing.startedAt === null) {
    data.startedAt = incoming.startedAt;
  }

  if (incoming.endedAt !== undefined && existing.endedAt === null) {
    data.endedAt = incoming.endedAt;
  }

  // Transcript: keep the FULLER text, so a late `call_analyzed` fills in (or
  // upgrades) a partial transcript, while an out-of-order/stale shorter one never
  // overwrites a better one.
  if (
    incoming.transcript !== undefined &&
    incoming.transcript.length > 0 &&
    (existing.transcript === null || incoming.transcript.length > existing.transcript.length)
  ) {
    data.transcript = incoming.transcript;
  }

  // Structured payloads and provider metadata: write once, when still empty, so a
  // redelivery never clobbers captured data.
  if (incoming.transcriptJson !== undefined && existing.transcriptJson === null) {
    data.transcriptJson = incoming.transcriptJson;
  }
  if (incoming.analysis !== undefined && existing.analysis === null) {
    data.analysis = incoming.analysis;
  }
  if (
    incoming.recordingUrl !== undefined &&
    incoming.recordingUrl.length > 0 &&
    existing.recordingUrl === null
  ) {
    data.recordingUrl = incoming.recordingUrl;
  }
  if (incoming.disconnectionReason !== undefined && existing.disconnectionReason === null) {
    data.disconnectionReason = incoming.disconnectionReason;
  }
  if (incoming.direction !== undefined && existing.direction === null) {
    data.direction = incoming.direction;
  }
  if (incoming.customerTz !== undefined && existing.customerTz === null) {
    data.customerTz = incoming.customerTz;
  }

  return data;
}

export interface ApplyWebhookResult {
  /** False when no call record matches the provider call id. */
  matched: boolean;
  /** True when the merge actually changed a field. */
  changed: boolean;
  record?: CallRecord;
}

/**
 * Applies a webhook event to the matching call record, keyed by the unique
 * provider call id, with terminal-safe / order-independent merge semantics.
 *
 * The row is locked `FOR UPDATE` inside the transaction so two webhook
 * deliveries that race cannot read-then-write over each other. An unknown
 * provider id returns `matched: false` — a webhook for a call we have no record
 * of never fabricates one, and is never attached to an unrelated lead.
 */
export async function applyWebhookCallEvent(
  providerCallId: string,
  incoming: WebhookCallUpdate,
): Promise<ApplyWebhookResult> {
  return prisma.$transaction(async (tx) => {
    // Lock the row (if it exists) for the duration of the transaction.
    await tx.$queryRaw`SELECT id FROM call_records WHERE "retellCallId" = ${providerCallId} FOR UPDATE`;

    const existing = await tx.callRecord.findUnique({ where: { retellCallId: providerCallId } });
    if (!existing) {
      return { matched: false, changed: false };
    }

    const data = computeSafeCallUpdate(existing, incoming);
    if (Object.keys(data).length === 0) {
      return { matched: true, changed: false, record: existing };
    }

    const record = await tx.callRecord.update({ where: { id: existing.id }, data });
    return { matched: true, changed: true, record };
  });
}

// ---------------------------------------------------------------------------
// CRM note delivery tracking (independent of the call result above)
//
// A note is delivered at most once per call (guarded by `noteStatus === 'sent'`).
// These writers only touch the note-* columns, so they never disturb the call
// result, the transcript, or the booking. A note failure is recorded, never
// thrown, so it can never roll back a persisted call record or booking.
// ---------------------------------------------------------------------------

/** Marks the lead's CRM call-note as delivered. */
export async function markCallNoteDelivered(
  callRecordId: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.callRecord.update({
    where: { id: callRecordId },
    data: {
      noteStatus: 'sent',
      noteError: null,
      noteAttempts: { increment: 1 },
      noteLastAttemptAt: now,
      noteDeliveredAt: now,
    },
  });
}

/** Records a failed CRM call-note attempt with a short, sanitized category. */
export async function markCallNoteFailed(
  callRecordId: string,
  errorCategory: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.callRecord.update({
    where: { id: callRecordId },
    data: {
      noteStatus: 'failed',
      noteError: errorCategory.slice(0, 200),
      noteAttempts: { increment: 1 },
      noteLastAttemptAt: now,
    },
  });
}

/** Marks that no CRM note is needed/possible for this call (e.g. no outcome). */
export async function markCallNoteSkipped(
  callRecordId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.callRecord.update({
    where: { id: callRecordId },
    data: { noteStatus: 'skipped', noteError: reason.slice(0, 200), noteLastAttemptAt: now },
  });
}

/**
 * Terminal call records whose CRM note has not been delivered, for a future
 * reconciliation/retry. Only rows that reached a terminal call status and whose
 * note is `failed` or not yet attempted are returned, oldest first.
 */
export async function findCallsWithUndeliveredNotes(limit: number): Promise<CallRecord[]> {
  return prisma.callRecord.findMany({
    where: {
      status: { in: [...TERMINAL_STATUSES] },
      OR: [{ noteStatus: null }, { noteStatus: 'failed' }],
    },
    orderBy: { endedAt: 'asc' },
    take: limit,
  });
}

/** Marks a never-dialled attempt as FAILED by its id (no provider call id exists). */
export async function markCallAttemptFailed(
  callRecordId: string,
  disconnectionReason: string,
  now: Date = new Date(),
): Promise<CallRecord> {
  return prisma.callRecord.update({
    where: { id: callRecordId },
    data: {
      status: CallStatus.FAILED,
      disconnectionReason: disconnectionReason.slice(0, 64),
      endedAt: now,
    },
  });
}
