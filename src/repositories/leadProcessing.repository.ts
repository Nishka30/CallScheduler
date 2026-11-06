import { Prisma, ProcessingStatus, type LeadProcessing } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/** Max length of the stored `lastError` column. */
const MAX_ERROR_LENGTH = 500;

/**
 * Reduces an arbitrary failure to a short, single-line, non-sensitive string.
 *
 * Provider payloads and connection strings must never land in the database, so
 * we strip credentials from URLs, collapse whitespace, and truncate.
 */
export function sanitizeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

  const withoutCredentials = raw
    // postgres://user:pass@host -> postgres://[REDACTED]@host
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g, '$1[REDACTED]@')
    // key=value pairs that look like secrets
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[=:]\s*\S+/gi,
      '$1=[REDACTED]',
    );

  const singleLine = withoutCredentials.replace(/\s+/g, ' ').trim();

  return singleLine.length > MAX_ERROR_LENGTH
    ? `${singleLine.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : singleLine;
}

/**
 * Creates the processing record for a lead if we have never seen it.
 *
 * Safe to call concurrently: the unique `leadId` constraint decides the winner
 * and the loser falls back to a read. Returns `created: false` for a lead that
 * is already in the workflow, which is how polling avoids re-queuing old leads.
 */
export async function ensureProcessingRecord(
  leadId: string,
): Promise<{ record: LeadProcessing; created: boolean }> {
  try {
    const record = await prisma.leadProcessing.create({ data: { leadId } });
    return { record, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.leadProcessing.findUniqueOrThrow({ where: { leadId } });
      return { record: existing, created: false };
    }
    throw error;
  }
}

/**
 * Atomically claims a PENDING lead for a single worker.
 *
 * The conditional update matches on (`id`, `status`, `version`) and bumps
 * `version`, so when two workers race, exactly one gets `count === 1` and the
 * other gets `null`. A unique `leadId` alone would not prevent this: it stops
 * duplicate rows, not duplicate work on the same row.
 *
 * Returns `null` when the lead does not exist, is not PENDING, or was claimed
 * by another worker first.
 */
export async function claimLeadForProcessing(
  leadId: string,
  workerId: string,
  now: Date = new Date(),
): Promise<LeadProcessing | null> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.leadProcessing.findUnique({ where: { leadId } });

    if (!current || current.status !== ProcessingStatus.PENDING) {
      return null;
    }

    const { count } = await tx.leadProcessing.updateMany({
      where: {
        id: current.id,
        status: ProcessingStatus.PENDING,
        version: current.version,
      },
      data: {
        status: ProcessingStatus.PROCESSING,
        version: { increment: 1 },
        attemptCount: { increment: 1 },
        claimedAt: now,
        claimedBy: workerId,
        lastAttemptAt: now,
      },
    });

    if (count === 0) {
      // Another worker won the race between our read and our write.
      return null;
    }

    return tx.leadProcessing.findUniqueOrThrow({ where: { id: current.id } });
  });
}

/**
 * Atomically claims an ELIGIBLE lead for a single caller worker.
 *
 * Mirrors `claimLeadForProcessing` but gates on `ELIGIBLE` rather than
 * `PENDING`: polling marks a verified lead `ELIGIBLE`, and this is how the call
 * orchestrator takes ownership of one for an outbound attempt. The conditional
 * update matches on (`id`, `status = ELIGIBLE`, `version`) and bumps `version`,
 * so when two workers race for the same lead exactly one gets the row and the
 * other gets `null`.
 *
 * Returns `null` when the lead does not exist, is not ELIGIBLE, or was claimed
 * by another worker first — never double-claims.
 */
export async function claimEligibleLead(
  leadId: string,
  workerId: string,
  now: Date = new Date(),
): Promise<LeadProcessing | null> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.leadProcessing.findUnique({ where: { leadId } });

    if (!current || current.status !== ProcessingStatus.ELIGIBLE) {
      return null;
    }

    const { count } = await tx.leadProcessing.updateMany({
      where: {
        id: current.id,
        status: ProcessingStatus.ELIGIBLE,
        version: current.version,
      },
      data: {
        status: ProcessingStatus.PROCESSING,
        version: { increment: 1 },
        attemptCount: { increment: 1 },
        claimedAt: now,
        claimedBy: workerId,
        lastAttemptAt: now,
      },
    });

    if (count === 0) {
      // Another worker won the race between our read and our write.
      return null;
    }

    return tx.leadProcessing.findUniqueOrThrow({ where: { id: current.id } });
  });
}

/**
 * Transitions a claimed lead from PROCESSING into CALLING, once.
 *
 * This is the gate immediately before an outbound call: a lead must already be
 * PROCESSING (claimed by this worker) and at the expected version. The
 * conditional update matches on (`id`, `version`, `status = PROCESSING`) and
 * bumps `version`, so a conflicting claim - another worker that already advanced
 * the row, or a stale version - yields `count === 0` and this returns `null`
 * instead of double-dialling.
 *
 * Returns the updated record (carrying the new `version`, which the caller needs
 * to later `completeProcessing`), or `null` when the transition did not apply.
 *
 * Deliberately a separate state from PROCESSING: once a lead is CALLING,
 * `requeueForRetry` refuses to touch it, so an uncertain in-flight call is never
 * auto-redialled.
 */
export async function markCalling(
  id: string,
  expectedVersion: number,
  now: Date = new Date(),
): Promise<LeadProcessing | null> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: { id, version: expectedVersion, status: ProcessingStatus.PROCESSING },
    data: {
      status: ProcessingStatus.CALLING,
      version: { increment: 1 },
      lastAttemptAt: now,
    },
  });

  if (count === 0) {
    // Not PROCESSING at the expected version: another worker advanced it first,
    // or the claim was taken over. Do not proceed to a call.
    return null;
  }

  return prisma.leadProcessing.findUniqueOrThrow({ where: { id } });
}

/**
 * Moves a claimed lead to a terminal state and releases the claim.
 *
 * Guarded by `version` so a worker whose claim already expired and was taken
 * over cannot overwrite the new owner's state.
 */
export async function completeProcessing(
  id: string,
  expectedVersion: number,
  status: typeof ProcessingStatus.COMPLETED | typeof ProcessingStatus.FAILED,
  error?: unknown,
): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: { id, version: expectedVersion },
    data: {
      status,
      version: { increment: 1 },
      claimedAt: null,
      claimedBy: null,
      lastError: error === undefined ? null : sanitizeErrorMessage(error),
    },
  });

  return count === 1;
}

/**
 * Finishes a lead's processing once its in-flight outbound call reaches a
 * terminal state (CALLING -> COMPLETED), driven by the Retell webhook.
 *
 * Status-guarded CAS matching ONLY `status = CALLING` (no version token, because
 * a webhook does not hold one). This is what protects against a duplicate or late
 * event overwriting a newer processing attempt: once the lead has moved on (to
 * COMPLETED, or to a different state from a later attempt) the update matches
 * nothing and is a safe no-op. Idempotent — a redelivered terminal event returns
 * `false`.
 *
 * Deliberately marks only that the AI caller's workflow for this lead is finished;
 * the per-call telephony/business result lives on the CallRecord. Retry policy for
 * no-answer/busy is a separate, explicit decision and is NOT applied here.
 */
export async function completeCallingLead(leadId: string): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: { leadId, status: ProcessingStatus.CALLING },
    data: {
      status: ProcessingStatus.COMPLETED,
      version: { increment: 1 },
      claimedAt: null,
      claimedBy: null,
    },
  });

  return count === 1;
}

/**
 * Finalizes a lead that polling marked ELIGIBLE but the calling stage then
 * refused BEFORE claiming it — an expired caller hold, the CRM routing/ownership
 * gate, an unvalidated phone, or a re-checked eligibility rule.
 *
 * Without this, those early orchestrator rejections persisted nothing, so the row
 * stayed ELIGIBLE forever: every later poll saw it as already-decided and never
 * retried it, and the re-evaluation sweep (NEEDS_REVIEW only) never looked at it —
 * the lead was stuck, uncallable and undiagnosable.
 *
 * Status-guarded CAS matching ONLY `status = ELIGIBLE` (like `completeCallingLead`,
 * no version token because the orchestrator never claimed the row): if a worker
 * claimed the lead (ELIGIBLE -> PROCESSING) between the orchestrator's read and
 * this write, the update matches nothing and is a safe no-op, so a lead mid-call is
 * never clobbered. It can NEVER touch a PENDING/PROCESSING/CALLING/COMPLETED/
 * FAILED/SKIPPED/NEEDS_REVIEW lead.
 *
 * The target status must be an already-decided state chosen to match the existing
 * semantics: SKIPPED for a terminal business/timing decision (never retried), or
 * NEEDS_REVIEW for a data-availability gap the re-evaluation sweep may retry. The
 * rejection `reason`/`detail` are retained so the lead's non-call is diagnosable.
 */
export async function finalizeRejectedEligibleLead(
  leadId: string,
  status: typeof ProcessingStatus.SKIPPED | typeof ProcessingStatus.NEEDS_REVIEW,
  reason: string,
  detail?: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: { leadId, status: ProcessingStatus.ELIGIBLE },
    data: {
      status,
      version: { increment: 1 },
      decisionReason: reason.slice(0, 64),
      decisionDetail: detail === undefined ? null : sanitizeDecisionDetail(detail),
      decidedAt: now,
    },
  });

  return count === 1;
}

/**
 * No-answer webhook sink: either schedules another call attempt or finishes the
 * lead once the attempt cap is reached.
 *
 * Status-guarded CAS matching ONLY `status = CALLING` (like `completeCallingLead`,
 * so a duplicate/late terminal event is a safe no-op):
 *   - `attemptCount < maxAttempts` -> CALLING -> RETRY_PENDING with `nextRetryAt`
 *     set, so the retry sweeper picks it up when due (persistent, restart-safe).
 *   - `attemptCount >= maxAttempts` -> CALLING -> COMPLETED (no further call).
 *
 * `attemptCount` is NOT touched here: it is incremented at each claim, so it already
 * equals the number of dial attempts made. The caller decides `nextRetryAt`.
 */
export async function scheduleRetryOrComplete(
  leadId: string,
  nextRetryAt: Date,
  maxAttempts: number,
  now: Date = new Date(),
): Promise<'scheduled' | 'completed' | 'noop'> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.leadProcessing.findUnique({ where: { leadId } });
    if (!current || current.status !== ProcessingStatus.CALLING) {
      return 'noop';
    }

    const reschedule = current.attemptCount < maxAttempts;
    const { count } = await tx.leadProcessing.updateMany({
      where: { id: current.id, version: current.version, status: ProcessingStatus.CALLING },
      data: reschedule
        ? {
            status: ProcessingStatus.RETRY_PENDING,
            version: { increment: 1 },
            claimedAt: null,
            claimedBy: null,
            nextRetryAt,
            decisionReason: 'no_answer_retry_scheduled',
            decidedAt: now,
          }
        : {
            status: ProcessingStatus.COMPLETED,
            version: { increment: 1 },
            claimedAt: null,
            claimedBy: null,
            nextRetryAt: null,
            decisionReason: 'no_answer_max_attempts',
            decidedAt: now,
          },
    });

    if (count !== 1) return 'noop';
    return reschedule ? 'scheduled' : 'completed';
  });
}

/** A RETRY_PENDING lead whose next attempt is due, with the fields the sweeper needs. */
export interface DueRetryLead {
  id: string;
  leadId: string;
  attemptCount: number;
  version: number;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
}

/**
 * Returns up to `limit` RETRY_PENDING leads whose `nextRetryAt` is in the past and
 * whose `attemptCount` is still under the cap, oldest-due first. A cheap LOCAL
 * query used by the no-answer retry sweeper to pick candidates.
 */
export async function findDueRetries(
  now: Date,
  maxAttempts: number,
  limit: number,
): Promise<DueRetryLead[]> {
  return prisma.leadProcessing.findMany({
    where: {
      status: ProcessingStatus.RETRY_PENDING,
      nextRetryAt: { lte: now },
      attemptCount: { lt: maxAttempts },
    },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
    select: {
      id: true,
      leadId: true,
      attemptCount: true,
      version: true,
      lastAttemptAt: true,
      nextRetryAt: true,
    },
  });
}

/**
 * Transitions a due retry RETRY_PENDING -> ELIGIBLE so the orchestrator can claim
 * and dial it through the normal calling path. Version-guarded CAS matching only
 * `status = RETRY_PENDING`, so two sweep workers cannot both begin the same retry.
 * Clears `nextRetryAt` (the attempt is now in progress). Does NOT touch
 * `attemptCount` — the orchestrator's claim increments it when it actually dials.
 */
export async function beginRetryAttempt(id: string, expectedVersion: number): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: { id, version: expectedVersion, status: ProcessingStatus.RETRY_PENDING },
    data: {
      status: ProcessingStatus.ELIGIBLE,
      version: { increment: 1 },
      nextRetryAt: null,
    },
  });
  return count === 1;
}

/**
 * Hold-expired handling at the calling stage, for an ELIGIBLE lead the orchestrator
 * rejected BEFORE claiming (so `attemptCount` was not consumed).
 *
 *   - A RETRY (prior attempts, still under the cap) goes back to RETRY_PENDING with
 *     a fresh `nextRetryAt`, so it waits for the CRM to re-issue a valid hold — the
 *     attempt is NOT spent, exactly as required.
 *   - A FIRST attempt (attemptCount 0) or an exhausted one goes to SKIPPED, the
 *     existing terminal behavior for a call that can no longer be placed.
 *
 * Status-guarded on `status = ELIGIBLE` so a lead another worker already claimed is
 * never clobbered.
 */
export async function finalizeHoldExpired(
  leadId: string,
  nextRetryAt: Date,
  maxAttempts: number,
  now: Date = new Date(),
): Promise<'rescheduled' | 'skipped' | 'noop'> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.leadProcessing.findUnique({ where: { leadId } });
    if (!current || current.status !== ProcessingStatus.ELIGIBLE) {
      return 'noop';
    }

    const reschedule = current.attemptCount >= 1 && current.attemptCount < maxAttempts;
    const { count } = await tx.leadProcessing.updateMany({
      where: { id: current.id, version: current.version, status: ProcessingStatus.ELIGIBLE },
      data: reschedule
        ? {
            status: ProcessingStatus.RETRY_PENDING,
            version: { increment: 1 },
            claimedAt: null,
            claimedBy: null,
            nextRetryAt,
            decisionReason: 'hold_expired',
            decidedAt: now,
          }
        : {
            status: ProcessingStatus.SKIPPED,
            version: { increment: 1 },
            claimedAt: null,
            claimedBy: null,
            nextRetryAt: null,
            decisionReason: 'hold_expired',
            decidedAt: now,
          },
    });

    if (count !== 1) return 'noop';
    return reschedule ? 'rescheduled' : 'skipped';
  });
}

/**
 * Safety net for the retry sweeper: returns a lead it moved RETRY_PENDING ->
 * ELIGIBLE (to hand to the orchestrator) back to RETRY_PENDING when the attempt did
 * not actually dial AND the orchestrator left it ELIGIBLE without persisting a
 * decision (e.g. a transient `lead_unavailable`, or calling disabled). Status-only
 * CAS on `status = ELIGIBLE`, so a lead that actually dialled (now CALLING) or was
 * finalized (RETRY_PENDING / SKIPPED) is a safe no-op.
 */
export async function reschedulePendingRetry(
  leadId: string,
  nextRetryAt: Date,
): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: { leadId, status: ProcessingStatus.ELIGIBLE },
    data: {
      status: ProcessingStatus.RETRY_PENDING,
      version: { increment: 1 },
      nextRetryAt,
    },
  });
  return count === 1;
}

/**
 * Returns a lead to PENDING so it can be picked up again.
 *
 * Deliberately refuses to requeue a lead in the CALLING state: an outbound call
 * request whose result we are unsure about may already have reached a real
 * customer, and re-running it would place a second call. Those leads must be
 * resolved explicitly (via webhook reconciliation or a human decision).
 */
export async function requeueForRetry(
  id: string,
  expectedVersion: number,
  reason?: unknown,
): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: {
      id,
      version: expectedVersion,
      status: { in: [ProcessingStatus.PENDING, ProcessingStatus.PROCESSING] },
    },
    data: {
      status: ProcessingStatus.PENDING,
      version: { increment: 1 },
      claimedAt: null,
      claimedBy: null,
      lastError: reason === undefined ? null : sanitizeErrorMessage(reason),
    },
  });

  return count === 1;
}

/** Looks up a single lead's processing state. */
export async function findByLeadId(leadId: string): Promise<LeadProcessing | null> {
  return prisma.leadProcessing.findUnique({ where: { leadId } });
}

/**
 * Resolves a lead the stuck-CALLING reaper moved to NEEDS_REVIEW (`call_unreconciled`)
 * when its real terminal outcome FINALLY arrives on a late webhook. The CallRecord is
 * enriched by the webhook merge separately; this just finishes the lead's workflow so
 * it does not sit in review forever. Status-guarded on NEEDS_REVIEW + `call_unreconciled`
 * (never touches any other NEEDS_REVIEW lead), and it NEVER initiates a call.
 */
export async function completeReconciledCall(
  leadId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: {
      leadId,
      status: ProcessingStatus.NEEDS_REVIEW,
      decisionReason: 'call_unreconciled',
    },
    data: {
      status: ProcessingStatus.COMPLETED,
      version: { increment: 1 },
      decidedAt: now,
      decisionDetail: 'resolved by a late terminal webhook after reconciliation',
    },
  });
  return count === 1;
}

// ---------------------------------------------------------------------------
// Persistent CRM review-note delivery (NEEDS_REVIEW + retry-hold-unavailable).
// A delivery INTENT is recorded on the lead so a review note is never lost on a
// transient failure or restart, and is delivered at most once per (lead, reason).
// These touch ONLY the reviewNote* columns, independent of processing status.
// ---------------------------------------------------------------------------

/**
 * Enqueues a review-note delivery intent, de-duplicated per (lead, reason):
 * sets `pending` only when no note exists yet (`null`), or a note was already
 * `sent` for a DIFFERENT reason (re-arm). An in-flight (`pending`/`failed`) note,
 * or one already `sent` for the SAME reason, is left untouched. Returns whether a
 * new intent was created.
 */
export async function createReviewNoteIntent(
  leadId: string,
  reason: string,
  detail: string | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: {
      leadId,
      OR: [
        { reviewNoteStatus: null },
        { AND: [{ reviewNoteStatus: 'sent' }, { reviewNoteReason: { not: reason } }] },
      ],
    },
    data: {
      reviewNoteStatus: 'pending',
      reviewNoteReason: reason.slice(0, 64),
      reviewNoteDetail: detail === undefined ? null : sanitizeDecisionDetail(detail),
      reviewNoteAttempts: 0,
      reviewNoteNextAttemptAt: now,
      reviewNoteError: null,
      reviewNoteSentAt: null,
    },
  });
  return count === 1;
}

/**
 * NEEDS_REVIEW leads whose notifiable reason never got a review-note intent (e.g. the
 * one-time enqueue write failed). The sweep backfills an intent for these so a review
 * note can never be silently missed. `reviewNoteStatus = null` means "no intent yet".
 */
export async function findNeedsReviewWithoutNote(
  reasons: readonly string[],
  limit: number,
): Promise<Array<{ leadId: string; decisionReason: string | null; decisionDetail: string | null }>> {
  if (reasons.length === 0) return [];
  return prisma.leadProcessing.findMany({
    where: {
      status: ProcessingStatus.NEEDS_REVIEW,
      reviewNoteStatus: null,
      decisionReason: { in: [...reasons] },
    },
    take: limit,
    select: { leadId: true, decisionReason: true, decisionDetail: true },
  });
}

/** A review note due for delivery. */
export interface DueReviewNote {
  leadId: string;
  reviewNoteReason: string | null;
  reviewNoteDetail: string | null;
  reviewNoteAttempts: number;
}

/**
 * Review notes due for a delivery attempt: `pending`/`failed`, under the attempt
 * cap, and past the backoff. Oldest first.
 */
export async function findReviewNotesForDelivery(
  now: Date,
  maxAttempts: number,
  limit: number,
): Promise<DueReviewNote[]> {
  return prisma.leadProcessing.findMany({
    where: {
      reviewNoteStatus: { in: ['pending', 'failed'] },
      reviewNoteAttempts: { lt: maxAttempts },
      reviewNoteNextAttemptAt: { lte: now },
    },
    orderBy: { reviewNoteNextAttemptAt: 'asc' },
    take: limit,
    select: {
      leadId: true,
      reviewNoteReason: true,
      reviewNoteDetail: true,
      reviewNoteAttempts: true,
    },
  });
}

/**
 * Claims a review note for delivery so concurrent sweeps do not both post it: CAS
 * matching the exact `reviewNoteAttempts` we read (and a deliverable status),
 * incrementing attempts and leasing `reviewNoteNextAttemptAt` forward. Exactly one
 * worker wins. (The CRM has no idempotency, so this MINIMISES duplicate notes; it
 * cannot guarantee exactly-once — see the delivery service.)
 */
export async function claimReviewNoteDelivery(
  leadId: string,
  expectedAttempts: number,
  leaseUntil: Date,
): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: {
      leadId,
      reviewNoteStatus: { in: ['pending', 'failed'] },
      reviewNoteAttempts: expectedAttempts,
    },
    data: { reviewNoteAttempts: { increment: 1 }, reviewNoteNextAttemptAt: leaseUntil },
  });
  return count === 1;
}

/** Marks a review note delivered (terminal, never re-sent for the same reason). */
export async function markReviewNoteSent(leadId: string, now: Date = new Date()): Promise<void> {
  await prisma.leadProcessing.updateMany({
    where: { leadId },
    data: {
      reviewNoteStatus: 'sent',
      reviewNoteSentAt: now,
      reviewNoteNextAttemptAt: null,
      reviewNoteError: null,
    },
  });
}

/** Records a failed review-note attempt and schedules the next retry. */
export async function markReviewNoteFailed(
  leadId: string,
  error: string,
  nextAttemptAt: Date,
): Promise<void> {
  await prisma.leadProcessing.updateMany({
    where: { leadId },
    data: {
      reviewNoteStatus: 'failed',
      reviewNoteError: sanitizeErrorMessage(error).slice(0, 200),
      reviewNoteNextAttemptAt: nextAttemptAt,
    },
  });
}

/** A lead a reconciliation sweep may need to act on. */
export interface ReconcileLead {
  id: string;
  leadId: string;
  version: number;
  attemptCount: number;
}

const RECONCILE_SELECT = {
  id: true,
  leadId: true,
  version: true,
  attemptCount: true,
} as const;

/**
 * CALLING leads whose last activity is older than `olderThan` — a terminal webhook
 * has very likely been missed. Oldest first.
 */
export async function findStuckCalling(olderThan: Date, limit: number): Promise<ReconcileLead[]> {
  return prisma.leadProcessing.findMany({
    where: { status: ProcessingStatus.CALLING, lastAttemptAt: { lte: olderThan } },
    orderBy: { lastAttemptAt: 'asc' },
    take: limit,
    select: RECONCILE_SELECT,
  });
}

/**
 * PROCESSING leads claimed before `olderThan` — a worker crashed after the claim
 * but before the lead reached CALLING (so NO call was placed). Oldest first.
 */
export async function findStuckProcessing(olderThan: Date, limit: number): Promise<ReconcileLead[]> {
  return prisma.leadProcessing.findMany({
    where: { status: ProcessingStatus.PROCESSING, claimedAt: { lte: olderThan } },
    orderBy: { claimedAt: 'asc' },
    take: limit,
    select: RECONCILE_SELECT,
  });
}

/**
 * ELIGIBLE leads decided before `olderThan` — the poll's inline call attempt did
 * not progress them (transient failure, or a crash mid-retry left them ELIGIBLE).
 * The backstop re-hands these to the orchestrator. Oldest first.
 */
export async function findEligibleNotCalled(
  olderThan: Date,
  limit: number,
): Promise<ReconcileLead[]> {
  return prisma.leadProcessing.findMany({
    where: { status: ProcessingStatus.ELIGIBLE, decidedAt: { lte: olderThan } },
    orderBy: { decidedAt: 'asc' },
    take: limit,
    select: RECONCILE_SELECT,
  });
}

/**
 * Reconciles a lead stuck in CALLING: CALLING -> NEEDS_REVIEW (`call_unreconciled`).
 *
 * SAFE FALLBACK by design — the call MAY have connected (we cannot query Retell;
 * the client has no read endpoint), so we never claim it completed and never make
 * it auto-redialable (`call_unreconciled` is not a re-evaluable reason). It is
 * surfaced to the RM via the CRM note flow instead. Version-guarded on CALLING, so
 * a real terminal webhook that arrives first wins and this is a no-op.
 */
export async function reconcileStuckCalling(
  id: string,
  expectedVersion: number,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: { id, version: expectedVersion, status: ProcessingStatus.CALLING },
    data: {
      status: ProcessingStatus.NEEDS_REVIEW,
      version: { increment: 1 },
      claimedAt: null,
      claimedBy: null,
      decidedAt: now,
      decisionReason: 'call_unreconciled',
      decisionDetail: 'call stuck in CALLING past the reconciliation timeout; no terminal webhook',
    },
  });
  return count === 1;
}

/**
 * Returns a lead stuck in PROCESSING to ELIGIBLE for another safe attempt. No call
 * is placed in PROCESSING (markCalling/recordCallAttempt/dial come after), so this
 * can never double-dial. The dial-less claim is un-counted (`attemptCount - 1`) so
 * the count keeps meaning "actual dial attempts". Version-guarded on PROCESSING.
 */
export async function requeueStuckProcessing(
  id: string,
  expectedVersion: number,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: { id, version: expectedVersion, status: ProcessingStatus.PROCESSING },
    data: {
      status: ProcessingStatus.ELIGIBLE,
      version: { increment: 1 },
      attemptCount: { decrement: 1 },
      claimedAt: null,
      claimedBy: null,
      decidedAt: now,
    },
  });
  return count === 1;
}

/** A NEEDS_REVIEW lead that may be worth re-evaluating, with its retry-scheduling fields. */
export interface ReevaluableLead {
  id: string;
  leadId: string;
  decisionReason: string | null;
  decidedAt: Date | null;
  version: number;
}

/**
 * Returns up to `limit` leads currently in NEEDS_REVIEW whose recorded reason is
 * one of `reasons` (the data-availability gaps worth retrying), oldest decision
 * first. This is a cheap LOCAL query used by the re-evaluation sweep to pick
 * candidates; the sweep then throttles per-lead before making any Lead API call,
 * so this returning already-throttled rows costs only local DB time, never a
 * Lead API request.
 */
export async function findReevaluableLeads(
  reasons: readonly string[],
  limit: number,
): Promise<ReevaluableLead[]> {
  if (reasons.length === 0) return [];
  return prisma.leadProcessing.findMany({
    where: { status: ProcessingStatus.NEEDS_REVIEW, decisionReason: { in: [...reasons] } },
    orderBy: { decidedAt: 'asc' },
    take: limit,
    select: { id: true, leadId: true, decisionReason: true, decidedAt: true, version: true },
  });
}

/** Max length of the stored `decisionDetail` column. */
const MAX_DETAIL_LENGTH = 300;

/** Processing states that mean "we have already judged this lead". */
const DECIDED_STATUSES = [
  ProcessingStatus.ELIGIBLE,
  ProcessingStatus.SKIPPED,
  ProcessingStatus.NEEDS_REVIEW,
  ProcessingStatus.PROCESSING,
  ProcessingStatus.CALLING,
  ProcessingStatus.COMPLETED,
  ProcessingStatus.FAILED,
] as const;

export interface LeadDecision {
  status:
    | typeof ProcessingStatus.ELIGIBLE
    | typeof ProcessingStatus.SKIPPED
    | typeof ProcessingStatus.NEEDS_REVIEW;
  reason: string;
  detail?: string;
  /** `updated_at` of the lead row that produced this decision. */
  leadUpdatedAt?: Date;
}

export interface RecordDecisionResult {
  /** False when the lead had already been decided and was left untouched. */
  applied: boolean;
  record: LeadProcessing;
}

/**
 * Records the eligibility decision for a lead, exactly once.
 *
 * Idempotent by design. The listing returns changed leads as well as new ones,
 * so the same lead will reappear across pages and polling cycles; the
 * conditional update only matches a row still in PENDING, which means:
 *
 *   * a lead already judged keeps its original decision, and
 *   * a later note, correction, assignment or status change can never promote
 *     an old lead back into the calling queue.
 *
 * Concurrency-safe: the create races on the unique `leadId`, and the decision
 * races on `status = PENDING`, so exactly one caller can apply a decision.
 */
export async function recordLeadDecision(
  leadId: string,
  decision: LeadDecision,
  now: Date = new Date(),
): Promise<RecordDecisionResult> {
  const { record } = await ensureProcessingRecord(leadId);

  if (record.status !== ProcessingStatus.PENDING) {
    return { applied: false, record };
  }

  const { count } = await prisma.leadProcessing.updateMany({
    where: { id: record.id, status: ProcessingStatus.PENDING, version: record.version },
    data: {
      status: decision.status,
      version: { increment: 1 },
      decisionReason: decision.reason.slice(0, 64),
      decisionDetail:
        decision.detail === undefined ? null : sanitizeDecisionDetail(decision.detail),
      decidedAt: now,
      leadUpdatedAt: decision.leadUpdatedAt ?? null,
    },
  });

  const latest = await prisma.leadProcessing.findUniqueOrThrow({ where: { id: record.id } });

  // count === 0 means another worker decided this lead between our read and
  // our write; its decision stands.
  return { applied: count === 1, record: latest };
}

/**
 * Re-applies a decision for a lead currently stuck in `NEEDS_REVIEW`, when the
 * original reason was a DATA-AVAILABILITY gap (e.g. the phone verdict was not
 * yet populated, or auto-eligibility was off) rather than a business decision.
 *
 * Deliberately separate from `recordLeadDecision`, which never transitions a
 * lead OUT of NEEDS_REVIEW (correctly - a later note/status edit must never
 * promote an old lead). This function is the explicit, narrow exception: it is
 * called ONLY from `leadReevaluation.service.ts`, ONLY for one lead id at a
 * time, on deliberate operator request - never from the automatic poll loop.
 *
 * Version-guarded CAS matching only `status = NEEDS_REVIEW`: it can NEVER touch
 * a PENDING, ELIGIBLE, SKIPPED, PROCESSING, CALLING, COMPLETED or FAILED lead,
 * so it cannot reset or reopen any other decision. A race (another process
 * already moved the lead) yields `applied: false`, which the caller must not
 * retry blindly.
 */
export async function reevaluateNeedsReviewDecision(
  id: string,
  expectedVersion: number,
  decision: LeadDecision,
  now: Date = new Date(),
): Promise<RecordDecisionResult> {
  const { count } = await prisma.leadProcessing.updateMany({
    where: { id, version: expectedVersion, status: ProcessingStatus.NEEDS_REVIEW },
    data: {
      status: decision.status,
      version: { increment: 1 },
      decisionReason: decision.reason.slice(0, 64),
      decisionDetail:
        decision.detail === undefined ? null : sanitizeDecisionDetail(decision.detail),
      decidedAt: now,
      leadUpdatedAt: decision.leadUpdatedAt ?? null,
    },
  });

  const latest = await prisma.leadProcessing.findUniqueOrThrow({ where: { id } });
  return { applied: count === 1, record: latest };
}

/**
 * Trims a decision explanation to something safe to persist.
 *
 * Reuses the credential stripping from `sanitizeErrorMessage` so a detail
 * derived from an error can never carry a secret into the database.
 */
export function sanitizeDecisionDetail(detail: string): string {
  const cleaned = sanitizeErrorMessage(detail);
  return cleaned.length > MAX_DETAIL_LENGTH
    ? `${cleaned.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : cleaned;
}

/** Leads already judged, used to skip redundant detail lookups. */
export async function findDecidedLeadIds(leadIds: string[]): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();

  const rows = await prisma.leadProcessing.findMany({
    where: { leadId: { in: leadIds }, status: { in: [...DECIDED_STATUSES] } },
    select: { leadId: true },
  });

  return new Set(rows.map((row) => row.leadId));
}

/** Aggregate counts per status, for reporting a poll run. */
export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await prisma.leadProcessing.groupBy({ by: ['status'], _count: { _all: true } });
  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
}
