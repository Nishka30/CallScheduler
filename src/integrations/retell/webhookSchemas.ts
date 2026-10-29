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
    custom_analysis_data: z.record(z.unknown()).nullish(),
  })
  .passthrough();

const callObjectSchema = z
  .object({
    call_id: z.string().min(1),
    call_status: z.string().nullish(),
    disconnection_reason: z.string().nullish(),
    direction: z.string().nullish(),
    call_type: z.string().nullish(),
    start_timestamp: z.number().int().nonnegative().nullish(),
    end_timestamp: z.number().int().nonnegative().nullish(),
    call_analysis: callAnalysisSchema.nullish(),
    /** Full transcript as plain text, provided on `call_analyzed` (and sometimes `call_ended`). */
    transcript: z.string().nullish(),
    /** Speaker-labelled utterances with word timings; preserved structurally. */
    transcript_object: z.array(z.unknown()).nullish(),
    /** Transcript including tool-call steps (e.g. booking tool invocations). */
    transcript_with_tool_calls: z.array(z.unknown()).nullish(),
    /** Recording URL(s), when Retell produced them and sharing is configured. */
    recording_url: z.string().nullish(),
    recording_multi_channel_url: z.string().nullish(),
    /** Provider public log URL for diagnosing a call. */
    public_log_url: z.string().nullish(),
    /** Agent identity/version that handled the call. */
    agent_id: z.string().nullish(),
    agent_version: z.number().int().nullish(),
    /** Non-PII diagnostics; captured into providerMetadata. */
    call_cost: z.record(z.unknown()).nullish(),
    latency: z.record(z.unknown()).nullish(),
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
