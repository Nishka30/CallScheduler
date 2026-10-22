import { z } from 'zod';
import { MEETING_TYPES } from '../leadApi/calendar.schemas.js';

/**
 * Defensive schemas for Retell custom-function ("tool") requests.
 *
 * IMPORTANT: a function-call payload is NOT the call-lifecycle webhook envelope
 * (`{ event, call }`). Retell posts the live `call` object together with the
 * function `name` and its `args`. Field spellings vary across Retell versions, so
 * we parse permissively and read only what we need:
 *
 *   - `call.call_id`   — the ONLY trusted lead binding (resolved server-side to a
 *                        CallRecord; we never trust a lead id from `args`).
 *   - `call.metadata`  — echoed back from call creation; cross-checked, not trusted.
 *   - `name`           — which tool was invoked (dispatch).
 *   - `args`/`arguments` — the LLM-produced arguments (object, or a JSON string).
 *
 * Everything else is preserved by `.passthrough()` rather than invented.
 */

/** Tool names the agent must be configured with (Retell dashboard). */
export const GET_SLOTS_FUNCTION = 'get_available_slots';
export const BOOK_FUNCTION = 'book_consultation';

const callRefSchema = z
  .object({
    call_id: z.string().min(1),
    metadata: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export const retellFunctionRequestSchema = z
  .object({
    call: callRefSchema,
    name: z.string().min(1).nullish(),
    /** Retell may send parsed args as an object, or a raw JSON string. */
    args: z.record(z.unknown()).nullish(),
    arguments: z.union([z.string(), z.record(z.unknown())]).nullish(),
  })
  .passthrough();

export type RetellFunctionRequest = z.infer<typeof retellFunctionRequestSchema>;

/**
 * Normalises the two spellings Retell uses for arguments into a plain object.
 * A malformed `arguments` string yields `{}` (the per-operation schema then
 * reports the missing fields) rather than throwing.
 */
export function readFunctionArgs(request: RetellFunctionRequest): Record<string, unknown> {
  if (request.args && typeof request.args === 'object') return request.args;
  const raw = request.arguments;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

/** Args for `get_available_slots`. */
export const getSlotsArgsSchema = z
  .object({
    timezone: z.string().min(1),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
  })
  .passthrough();

/** Args for `book_consultation`. The lead id is NEVER taken from here. */
export const bookArgsSchema = z
  .object({
    timezone: z.string().min(1),
    starts_at: z.string().min(1),
    meeting_type: z.enum(MEETING_TYPES).optional(),
    /** The agent sets this true only after the customer confirms the summary. */
    confirmed: z.boolean().optional(),
    confirmed_destination: z.string().min(1),
    preferred_trek: z.string().min(1).optional(),
    trip_duration: z.string().min(1).optional(),
    group_size: z.string().min(1).optional(),
    travel_timing: z.string().min(1).optional(),
    special_requirements: z.string().min(1).optional(),
    /** Original enquiry destination, when the customer confirmed a change. */
    destination_changed_from: z.string().min(1).optional(),
  })
  .passthrough();
