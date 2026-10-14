import { z } from 'zod';

/**
 * Defensive schema for the `POST /v2/create-phone-call` response.
 *
 * Verified against Retell's official OpenAPI spec (2026-10-15): the 201 response
 * always carries `call_id`, `agent_id`, `call_status`, `call_type`,
 * `from_number`, `to_number` and `direction`, plus optional fields that fill in
 * as the call progresses. We type only the fields we actually use and keep the
 * rest via `.passthrough()` rather than inventing them.
 *
 * `call_id` is the single field we structurally require - it is what we persist
 * as `CallRecord.retellCallId` to make later webhooks idempotent. A response
 * without it is a contract violation, never silently treated as success.
 */
export const createPhoneCallResponseSchema = z
  .object({
    call_id: z.string().min(1),
    agent_id: z.string().min(1).nullish(),
    /** registered | not_connected | ongoing | ended | error (per the spec). */
    call_status: z.string().min(1).nullish(),
    call_type: z.string().nullish(),
    direction: z.string().nullish(),
  })
  .passthrough();

export type CreatePhoneCallResponse = z.infer<typeof createPhoneCallResponseSchema>;

/** The documented error-body shape; only the message field is ever read. */
export const retellErrorBodySchema = z
  .object({
    error_message: z.string().nullish(),
    message: z.string().nullish(),
  })
  .passthrough();

/**
 * The safe subset of a successful create-call we hand back to callers.
 *
 * Deliberately excludes anything that could echo the destination number; the
 * caller already knows the lead it asked us to call.
 */
export interface CreatePhoneCallResult {
  /** Provider call id -> stored as CallRecord.retellCallId. */
  callId: string;
  agentId?: string;
  /** Provider lifecycle status at creation, typically "registered". */
  callStatus?: string;
}
