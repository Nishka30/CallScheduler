import { Prisma, type LeadLifecycleEvent } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/**
 * Persistence for the append-only lead lifecycle history (`lead_lifecycle_events`).
 *
 * This module owns ONLY the history table. It never contacts the Lead API or
 * Retell and never mutates `lead_processing` / `call_records`; it records what
 * the existing flow already decided, so the "what happened to this lead" trace
 * survives in the database independent of console-log retention.
 *
 * Scope: NO personal data is stored. `metadata` carries only non-PII context
 * (routing labels, hold timestamps, boolean flags, provider ids).
 */

/** Column length limits, matching `schema.prisma`. */
const MAX_EVENT_LENGTH = 64;
const MAX_STATUS_LENGTH = 32;
const MAX_REASON_LENGTH = 64;
const MAX_DETAIL_LENGTH = 300;

/** Hard cap on how many events a single lead's timeline returns. */
const MAX_EVENTS_RETURNED = 500;

export interface RecordLifecycleEventInput {
  leadId: string;
  /** Machine-readable stage code, e.g. `lead_received`. */
  event: string;
  /** Stage status label, e.g. `ELIGIBLE`, `passed`, `rejected`, `active`. */
  status?: string | null;
  /** Stable machine-readable reason code (mirrors `lead_processing` codes). */
  reason?: string | null;
  /** Short sanitized human-readable elaboration (never PII / raw payload). */
  detail?: string | null;
  /** Non-PII structured context. Undefined/null are stored as SQL NULL. */
  metadata?: Prisma.InputJsonValue | null;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Appends one lifecycle event. Returns the created row.
 *
 * Callers in the hot path should use the best-effort wrapper in
 * `leadLifecycle.service.ts` rather than calling this directly, so that a
 * history-write failure can never break lead processing or a call.
 */
export async function recordLifecycleEvent(
  input: RecordLifecycleEventInput,
): Promise<LeadLifecycleEvent> {
  return prisma.leadLifecycleEvent.create({
    data: {
      leadId: input.leadId,
      event: clip(input.event, MAX_EVENT_LENGTH) ?? 'unknown',
      status: clip(input.status, MAX_STATUS_LENGTH),
      reason: clip(input.reason, MAX_REASON_LENGTH),
      detail: clip(input.detail, MAX_DETAIL_LENGTH),
      metadata:
        input.metadata === undefined || input.metadata === null
          ? Prisma.JsonNull
          : input.metadata,
    },
  });
}

/**
 * Returns a lead's lifecycle events in chronological order (oldest first).
 *
 * `id` is the stable tiebreaker so events written in the same millisecond keep a
 * deterministic order. Capped at {@link MAX_EVENTS_RETURNED}.
 */
export async function listLifecycleEventsByLead(
  leadId: string,
): Promise<LeadLifecycleEvent[]> {
  return prisma.leadLifecycleEvent.findMany({
    where: { leadId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_EVENTS_RETURNED,
  });
}
