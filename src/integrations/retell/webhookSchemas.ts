import { z } from 'zod';

/**
 * Defensive schemas for Retell webhook payloads.
 *
 * Field names verified against Retell's official webhook docs and SDK types
 * (retell-sdk v6.2.6): the envelope is `{ event, call }`, the call object
 * carries `call_id`, `call_status`, `disconnection_reason`, `start_timestamp`,
 * `end_timestamp` (ms), and (on `call_analyzed`) a `call_analysis` object.
 *
 * Only the fields we actually use are typed; everything else is preserved by
 * `.passthrough()` rather than invented. `call_id` is the one structurally
 * required field — it is how an event is matched to a `CallRecord`.
 */

/** The three voice lifecycle events this handler processes. */
export const SUPPORTED_EVENTS = ['call_started', 'call_ended', 'call_analyzed'] as const;
export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

export function isSupportedEvent(event: string): event is SupportedEvent {
  return (SUPPORTED_EVENTS as readonly string[]).includes(event);
}

const callAnalysisSchema = z
  .object({
    call_successful: z.boolean().nullish(),
    call_summary: z.string().nullish(),
    in_voicemail: z.boolean().nullish(),
    user_sentiment: z.string().nullish(),
  })
  .passthrough();

const callObjectSchema = z
  .object({
    call_id: z.string().min(1),
    call_status: z.string().nullish(),
    disconnection_reason: z.string().nullish(),
    start_timestamp: z.number().int().nonnegative().nullish(),
    end_timestamp: z.number().int().nonnegative().nullish(),
    call_analysis: callAnalysisSchema.nullish(),
  })
  .passthrough();

export const retellWebhookEventSchema = z
  .object({
    event: z.string().min(1),
    call: callObjectSchema,
  })
  .passthrough();

export type RetellWebhookEvent = z.infer<typeof retellWebhookEventSchema>;
export type RetellCallObject = z.infer<typeof callObjectSchema>;
