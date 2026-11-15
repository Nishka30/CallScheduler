import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { LeadApiError } from '../leadApi/errors.js';
import { normalizeAnswers } from '../../services/leadContext.service.js';
import type { FormAnswer } from '../../services/leadContext.service.js';

/**
 * Runtime validation + internal representation for the Guided Boost caller queue
 * (`GET /api/caller/queue`).
 *
 * Boundary discipline:
 *   - The external payload is validated in its EXACT confirmed field names
 *     (snake_case) at the integration boundary. Malformed or missing required
 *     fields are rejected, never silently accepted.
 *   - It is then converted to the internal `QueueLead` representation (camelCase,
 *     parsed types). Downstream code only ever sees `QueueLead`.
 *
 * Confirmed queue item fields (David): lead_id, phone, name, email, brand,
 * page_slug, answers, summary, time_zone, offered_at, call_before, is_test.
 *
 * The queue returns zero or one lead; the response wrapper shape is not fully
 * confirmed, so `parseQueueResponse` extracts the item defensively (bare array or
 * a common `{leads|queue|data|items|results}` / `{lead}` wrapper) without
 * inventing any item field.
 */

const PATH = '/api/caller/queue';

/** Accepts any ISO-8601-ish timestamp Date can parse; rejects anything else. */
const isoTimestamp = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a parseable ISO-8601 timestamp');

/**
 * The external queue item, validated in its confirmed snake_case names.
 *
 * Required (we cannot act safely without them): `lead_id` (identity), `phone`
 * (destination), `offered_at` and `call_before` (the authoritative timing). The
 * rest are optional/nullable: a lead may legitimately lack a name, answers, etc.,
 * and the context builder already tolerates missing context. `answers` is kept as
 * raw unknown[] here and normalized by the existing shared normalizer on
 * conversion. Unknown extra keys are preserved by `.passthrough()`, not rejected.
 */
export const queueItemSchema = z
  .object({
    lead_id: z.string().min(1),
    phone: z.string().min(1),
    name: z.string().nullish(),
    email: z.string().nullish(),
    brand: z.string().nullish(),
    page_slug: z.string().nullish(),
    answers: z.array(z.unknown()).nullish(),
    summary: z.string().nullish(),
    time_zone: z.string().nullish(),
    offered_at: isoTimestamp,
    call_before: isoTimestamp,
    is_test: z.boolean().nullish(),
  })
  .passthrough();

export type QueueItem = z.infer<typeof queueItemSchema>;

/**
 * The internal representation handed to the queue call path.
 *
 * `offeredAt` and `callBeforeAt` are absolute instants parsed from the payload;
 * `callBeforeAt` is the AUTHORITATIVE deadline. `time_zone` is carried as a hint
 * only and is never treated as the deadline authority.
 */
export interface QueueLead {
  leadId: string;
  /** Raw phone as offered; validated/normalized by the existing phone verdict logic. */
  phone: string;
  name?: string;
  email?: string;
  brand?: string;
  pageSlug?: string;
  /** Normalized via the shared `normalizeAnswers`; malformed entries dropped. */
  answers: FormAnswer[];
  summary?: string;
  timeZone?: string;
  /** Absolute instant the lead was offered. */
  offeredAt: Date;
  /** Absolute authoritative deadline (`call_before`). Never local-time derived. */
  callBeforeAt: Date;
  /** Guided Boost test flag; flows through without special-casing. */
  isTest: boolean;
}

/** Converts a validated external item to the internal representation. */
export function toQueueLead(item: QueueItem): QueueLead {
  return {
    leadId: item.lead_id,
    phone: item.phone,
    ...(item.name ? { name: item.name } : {}),
    ...(item.email ? { email: item.email } : {}),
    ...(item.brand ? { brand: item.brand } : {}),
    ...(item.page_slug ? { pageSlug: item.page_slug } : {}),
    answers: normalizeAnswers(item.answers ?? []),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.time_zone ? { timeZone: item.time_zone } : {}),
    offeredAt: new Date(item.offered_at),
    callBeforeAt: new Date(item.call_before),
    isTest: item.is_test === true,
  };
}

/**
 * Extracts the (0 or 1) offered item from an unconfirmed response wrapper without
 * inventing fields: a bare array, a common array wrapper, a `{lead}` wrapper, or a
 * single bare item object are all accepted; anything else yields no items.
 */
function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['leads', 'queue', 'data', 'items', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    if ('lead' in obj) {
      const single = obj['lead'];
      return single === null || single === undefined ? [] : [single];
    }
    if (typeof obj['lead_id'] === 'string') return [obj];
  }
  return [];
}

/**
 * Validates a queue response and returns the single offered `QueueLead`, or null
 * when the queue is empty. Throws a `LeadApiError('contract', …)` for a present
 * but malformed item — never silently drops a bad required field.
 */
export function parseQueueResponse(payload: unknown): QueueLead | null {
  const items = extractItems(payload);
  if (items.length === 0) return null;
  if (items.length > 1) {
    logger.warn(
      { count: items.length },
      'caller queue returned more than one lead; contract is 0 or 1 — using the first',
    );
  }

  const parsed = queueItemSchema.safeParse(items[0]);
  if (!parsed.success) {
    throw new LeadApiError('contract', 'Caller queue item did not match the expected shape', {
      path: PATH,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`),
    });
  }

  return toQueueLead(parsed.data);
}
