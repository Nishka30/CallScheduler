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
