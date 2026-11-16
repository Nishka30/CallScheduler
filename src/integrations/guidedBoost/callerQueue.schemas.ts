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
 * CONFIRMED response shape (David, observed in production):
 *   { "now": "<iso>", "leads": [ { "id": "<lead id>", ... } ] }
 * `leads` is an ARRAY, and the lead item's identifier is `id` (NOT `lead_id`).
 * The remaining item fields (phone, name, email, brand, page_slug, answers,
 * summary, time_zone, offered_at, call_before, is_test) are OPTIONAL: a given
 * offer may carry only a subset, so a missing one must never reject the whole
 * response (that previously threw and stalled the poller). `lead_id` is still
 * accepted as a fallback for the earlier written contract.
 *
 * The queue returns zero or one lead; `parseQueueResponse` extracts the item from
 * the `leads` array (or a bare array / `{lead}` wrapper) without inventing fields.
 */

const PATH = '/api/caller/queue';

/** Accepts any ISO-8601-ish timestamp Date can parse; rejects anything else. */
const isoTimestamp = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a parseable ISO-8601 timestamp');

/**
 * The external queue item. The ONLY required field is the lead identifier, which
 * Guided Boost sends as `id` (with `lead_id` accepted as a fallback). Everything
 * else is optional/nullable so a partial offer still parses and reaches the worker;
 * absent context is tolerated downstream, and an absent phone is handled by the
 * existing phone-verdict check (recorded not-attempted), never a thrown error.
 * `.passthrough()` preserves unknown extra keys rather than rejecting them.
 */
export const queueItemSchema = z
  .object({
    id: z.string().min(1).optional(),
    lead_id: z.string().min(1).optional(),
    phone: z.string().min(1).nullish(),
    name: z.string().nullish(),
    email: z.string().nullish(),
    brand: z.string().nullish(),
    page_slug: z.string().nullish(),
    answers: z.array(z.unknown()).nullish(),
    summary: z.string().nullish(),
    time_zone: z.string().nullish(),
    offered_at: isoTimestamp.nullish(),
    call_before: isoTimestamp.nullish(),
    is_test: z.boolean().nullish(),
  })
  .passthrough()
  .refine((item) => typeof item.id === 'string' || typeof item.lead_id === 'string', {
    message: 'a lead identifier (`id` or `lead_id`) is required',
  });

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
  /** Raw phone as offered, when present; validated by the existing phone verdict logic. */
  phone?: string;
  name?: string;
  email?: string;
  brand?: string;
  pageSlug?: string;
  /** Normalized via the shared `normalizeAnswers`; malformed entries dropped. */
  answers: FormAnswer[];
  summary?: string;
  timeZone?: string;
  /** Absolute instant the lead was offered, when present. */
  offeredAt?: Date;
  /** Absolute authoritative deadline (`call_before`), when present. Never local-time derived. */
  callBeforeAt?: Date;
  /** Guided Boost test flag; flows through without special-casing. */
  isTest: boolean;
}

/**
 * Converts a validated external item to the internal representation. The identifier
 * is taken from `id` (Guided Boost's actual field), falling back to `lead_id`; the
 * refine on `queueItemSchema` guarantees one is present.
 */
export function toQueueLead(item: QueueItem): QueueLead {
  const leadId = item.id ?? item.lead_id;
  if (!leadId) {
    // Unreachable given the schema refine; kept so the type is a plain string.
    throw new LeadApiError('contract', 'Caller queue item has no id', { path: PATH });
  }
  return {
    leadId,
    ...(item.phone ? { phone: item.phone } : {}),
    ...(item.name ? { name: item.name } : {}),
    ...(item.email ? { email: item.email } : {}),
    ...(item.brand ? { brand: item.brand } : {}),
    ...(item.page_slug ? { pageSlug: item.page_slug } : {}),
    answers: normalizeAnswers(item.answers ?? []),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.time_zone ? { timeZone: item.time_zone } : {}),
    ...(item.offered_at ? { offeredAt: new Date(item.offered_at) } : {}),
    ...(item.call_before ? { callBeforeAt: new Date(item.call_before) } : {}),
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
    if (typeof obj['id'] === 'string' || typeof obj['lead_id'] === 'string') return [obj];
  }
  return [];
}

/**
 * Validates a queue response and returns the single offered `QueueLead`, or null
 * when the queue is empty.
 *
 * A present-but-malformed item is logged (with the Zod issue locations) and treated
 * as an empty queue — it returns null rather than THROWING. The throw was what
 * turned a single field-shape surprise into a stalled poller (the worker caught it,
 * marked the cycle failed, and backed off), silently dropping real leads. Returning
 * null keeps the poller running at its normal cadence while making the mismatch
 * loudly visible in logs.
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
    logger.error(
      {
        path: PATH,
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`),
      },
      'caller queue: offered item did not match the expected shape; skipping this cycle',
    );
    return null;
  }

  return toQueueLead(parsed.data);
}
