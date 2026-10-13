import type { IntegrationCursor } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/** Integration key for the Lead API incremental listing. */
export const LEAD_API_SOURCE = 'LEAD_API';

/**
 * Reads the stored polling position, creating an empty one on first use.
 *
 * A row with no `cursor`, no `watermarkAt` and no `bootstrapCompletedAt` means
 * "we have never polled", which is what triggers the bootstrap run.
 */
export async function getOrCreateCursor(
  source: string = LEAD_API_SOURCE,
): Promise<IntegrationCursor> {
  return prisma.integrationCursor.upsert({
    where: { source },
    update: {},
    create: { source },
  });
}

export interface CursorAdvance {
  /** Exactly the `nextCursor` the API returned, or null at the end of a run. */
  cursor: string | null;
  /** `updated_at` of the last row we durably accounted for. */
  watermarkAt: Date | null;
}

/**
 * Advances the durable polling position.
 *
 * MUST only be called after every row on the corresponding page has been
 * durably recorded. If the process dies mid-page, the cursor still points at
 * the last fully processed position and the page is simply re-read; the unique
 * `leadId` on LeadProcessing makes re-ingestion a no-op.
 *
 * The watermark never moves backwards - a late or out-of-order page cannot
 * rewind progress and cause leads to be reconsidered.
 */
export async function advanceCursor(
  advance: CursorAdvance,
  source: string = LEAD_API_SOURCE,
  now: Date = new Date(),
): Promise<IntegrationCursor> {
  const existing = await getOrCreateCursor(source);

  const nextWatermark =
    advance.watermarkAt && (!existing.watermarkAt || advance.watermarkAt > existing.watermarkAt)
      ? advance.watermarkAt
      : existing.watermarkAt;

  return prisma.integrationCursor.update({
    where: { source },
    data: {
      cursor: advance.cursor,
      watermarkAt: nextWatermark,
      lastAdvancedAt: now,
    },
  });
}

/**
 * Records that the first (bootstrap) poll finished.
 *
 * Until this is set, no lead can become ELIGIBLE: everything visible on the
 * first run pre-dates the AI Caller and is recorded as known-before-bootstrap.
 */
export async function markBootstrapComplete(
  source: string = LEAD_API_SOURCE,
  now: Date = new Date(),
): Promise<IntegrationCursor> {
  return prisma.integrationCursor.update({
    where: { source },
    data: { bootstrapCompletedAt: now },
  });
}

/** True when the first poll has not yet completed. */
export function isBootstrapPending(cursor: IntegrationCursor): boolean {
  return cursor.bootstrapCompletedAt === null;
}
