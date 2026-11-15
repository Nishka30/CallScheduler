import { LeadSource } from '@prisma/client';

/**
 * Strongly typed representation of a lead's origin inside the AI Caller workflow.
 *
 * The single source of truth is the Prisma-generated `LeadSource` enum
 * (`POLL` | `QUEUE`); this module re-exports it and adds narrow, type-safe
 * helpers so the rest of the codebase never compares against raw `"poll"` /
 * `"queue"` string literals.
 *
 * Step 1 scope: this only CLASSIFIES origin. No behavior is attached to the
 * source yet — the poll path continues to behave exactly as it does today, and
 * every existing record is `POLL` by the column default.
 */
export { LeadSource };

/** Convenience type alias for the enum's value union. */
export type LeadSourceValue = (typeof LeadSource)[keyof typeof LeadSource];

/** The default source for any lead whose origin is not explicitly the queue. */
export const DEFAULT_LEAD_SOURCE: LeadSourceValue = LeadSource.POLL;

/** True when the lead entered via the Guided Boost queue hand-off. */
export function isQueueSource(source: LeadSourceValue | null | undefined): boolean {
  return source === LeadSource.QUEUE;
}

/** True when the lead entered via the incremental Lead API poll. */
export function isPollSource(source: LeadSourceValue | null | undefined): boolean {
  // Treat null/undefined (pre-column rows read defensively) as POLL, matching the
  // database default so legacy data is never mistaken for a queue lead.
  return !isQueueSource(source);
}

/**
 * Parses an untrusted string into a `LeadSource`, case-insensitively, returning
 * `undefined` for anything unrecognized rather than guessing. Accepts both the
 * canonical enum spelling (`POLL`/`QUEUE`) and lower-case (`poll`/`queue`).
 */
export function parseLeadSource(value: unknown): LeadSourceValue | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.trim().toUpperCase()) {
    case LeadSource.POLL:
      return LeadSource.POLL;
    case LeadSource.QUEUE:
      return LeadSource.QUEUE;
    default:
      return undefined;
  }
}
