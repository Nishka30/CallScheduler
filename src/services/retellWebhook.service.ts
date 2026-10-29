import { CallStatus, type Prisma, type CallRecord } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { verifyRetellSignature } from '../integrations/retell/webhookVerify.js';
import {
  isSupportedEvent,
  retellWebhookEventSchema,
} from '../integrations/retell/webhookSchemas.js';
import { mapRetellResult } from '../integrations/retell/outcomeMap.js';
import {
  applyWebhookCallEvent,
  type WebhookCallUpdate,
} from '../repositories/callRecord.repository.js';
import { completeCallingLead } from '../repositories/leadProcessing.repository.js';
import { deliverCallNote } from './callNoteDelivery.service.js';

/** Call statuses that mean the attempt is finished (telephony-terminal). */
const TERMINAL_CALL_STATUSES: ReadonlySet<CallStatus> = new Set([
  CallStatus.COMPLETED,
  CallStatus.FAILED,
  CallStatus.NO_ANSWER,
  CallStatus.BUSY,
  CallStatus.CANCELED,
]);

/**
 * Outcome of processing one webhook delivery. HTTP-agnostic so it can be unit
 * tested without Express; the controller maps each case to a status code.
 */
export type WebhookResult =
  | { status: 'misconfigured'; reason: string }
  | { status: 'unauthorized'; reason: string }
  | { status: 'bad_request'; reason: string }
  | { status: 'ignored'; event: string }
  | { status: 'unmatched'; event: string; callId: string }
  | { status: 'processed'; event: string; callId: string; changed: boolean };

export interface ProcessWebhookInput {
  /** Exact raw request body bytes, as a string. */
  rawBody: string;
  /** The `x-retell-signature` header value. */
  signature: string | undefined;
  /** Verification secret — the Retell API key (Retell signs with it). */
  apiKey: string | undefined;
  /** Injected for tests; passed to the replay-window check. */
  now?: number;
}

/**
 * Verifies, validates, maps and persists one Retell webhook event.
 *
 * Order matters and each step fails closed:
 *   1. secret present (else misconfigured — fail closed),
 *   2. signature present and valid (else unauthorized),
 *   3. body is JSON and matches the event schema (else bad_request),
 *   4. event is one we support (else ignored — acknowledged, no retry),
 *   5. map conservatively and apply with terminal-safe / idempotent merge.
 *
 * A database error is allowed to throw so the controller returns 5xx and Retell
 * retries (the merge makes a retry safe).
 */
export async function processRetellWebhook(input: ProcessWebhookInput): Promise<WebhookResult> {
  if (!input.apiKey) {
    return { status: 'misconfigured', reason: 'RETELL_API_KEY not configured for verification' };
  }
  if (!input.signature) {
    return { status: 'unauthorized', reason: 'missing signature header' };
  }

  const signatureValid = verifyRetellSignature(
    input.rawBody,
    input.apiKey,
    input.signature,
    input.now === undefined ? {} : { now: input.now },
  );
  if (!signatureValid) {
    return { status: 'unauthorized', reason: 'invalid signature' };
  }

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    return { status: 'bad_request', reason: 'body is not valid JSON' };
  }

  const parsed = retellWebhookEventSchema.safeParse(json);
  if (!parsed.success) {
    return { status: 'bad_request', reason: 'payload did not match the expected shape' };
  }

  const event = parsed.data;

  if (!isSupportedEvent(event.event)) {
    // Acknowledged so Retell does not retry; nothing is done.
    logger.debug({ event: event.event }, 'ignoring unsupported retell webhook event');
    return { status: 'ignored', event: event.event };
  }

  const mapped = mapRetellResult(event);
  const call = event.call;

  const update: WebhookCallUpdate = { status: mapped.status, outcome: mapped.outcome };
  const summary = call.call_analysis?.call_summary;
  if (typeof summary === 'string' && summary.length > 0) update.summary = summary;
  if (typeof call.start_timestamp === 'number') update.startedAt = new Date(call.start_timestamp);
  if (typeof call.end_timestamp === 'number') update.endedAt = new Date(call.end_timestamp);
  // Full call record: transcript, structured transcript/analysis, recording URL and
  // provider metadata. The repository merge keeps the fuller/earliest safe value,
  // so a late or duplicate webhook never clobbers better data.
  if (typeof call.transcript === 'string' && call.transcript.length > 0) {
    update.transcript = call.transcript;
  }
  if (call.transcript_object) update.transcriptJson = asJson(call.transcript_object);
  if (call.call_analysis) update.analysis = asJson(call.call_analysis);
  if (typeof call.recording_url === 'string' && call.recording_url.length > 0) {
    update.recordingUrl = call.recording_url;
  }
  if (typeof call.disconnection_reason === 'string') {
    update.disconnectionReason = call.disconnection_reason;
  }
  if (typeof call.direction === 'string') update.direction = call.direction;
  // Agent identity/version, extra recording/log URLs, tool-call transcript.
  if (typeof call.agent_id === 'string') update.agentId = call.agent_id;
  if (typeof call.agent_version === 'number') update.agentVersion = call.agent_version;
  if (call.transcript_with_tool_calls) {
    update.transcriptWithToolCalls = asJson(call.transcript_with_tool_calls);
  }
  if (typeof call.recording_multi_channel_url === 'string' && call.recording_multi_channel_url) {
    update.recordingMultiChannelUrl = call.recording_multi_channel_url;
  }
  if (typeof call.public_log_url === 'string' && call.public_log_url) {
    update.publicLogUrl = call.public_log_url;
  }
  // Curated, non-PII diagnostics only (cost/latency/type) — never phone numbers.
  const metrics = buildProviderMetadata(call);
  if (metrics) update.providerMetadata = asJson(metrics);

  const result = await applyWebhookCallEvent(call.call_id, update);

  if (!result.matched) {
    // Unknown provider call id: never fabricate a lead/call association.
    logger.warn(
      { event: event.event, callId: call.call_id },
      'retell webhook references a call id we have no record of; ignoring',
    );
    return { status: 'unmatched', event: event.event, callId: call.call_id };
  }

  // When the call has reached a terminal state, finish the lead's processing
  // (CALLING -> COMPLETED). This is SECONDARY to the authoritative call-record
  // update above: a failure here is logged but never fails the webhook (the record
  // is already persisted and a later event / reaper can retry), and a duplicate or
  // late terminal event is a safe, status-guarded no-op.
  await completeLeadIfCallTerminal(result.record, call.call_id);

  // Record the call in the CRM (a note for EVERY outcome), once. Secondary to the
  // local record: it never fails the webhook, and the local record is already
  // persisted, so a CRM note failure never loses data.
  await deliverCallNoteIfTerminal(event.event, result.record);

  logger.info(
    { event: event.event, callId: call.call_id, changed: result.changed },
    'retell webhook applied',
  );
  return { status: 'processed', event: event.event, callId: call.call_id, changed: result.changed };
}

/** JSON-safe clone, so a structured payload is always a valid Prisma JSON value. */
function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Collects the non-PII diagnostics worth retaining (cost, latency, call type) into
 * one object, or undefined when none are present. Deliberately excludes phone
 * numbers and any other sensitive fields — only these curated metrics are stored.
 */
function buildProviderMetadata(call: {
  call_cost?: Record<string, unknown> | null | undefined;
  latency?: Record<string, unknown> | null | undefined;
  call_type?: string | null | undefined;
}): Record<string, unknown> | undefined {
  const metrics: Record<string, unknown> = {};
  if (call.call_cost) metrics['call_cost'] = call.call_cost;
  if (call.latency) metrics['latency'] = call.latency;
  if (typeof call.call_type === 'string') metrics['call_type'] = call.call_type;
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

/**
 * Delivers the CRM call note once the call is terminal, exactly once.
 *
 * Timing: a completed conversation's transcript/analysis arrives on
 * `call_analyzed`, so for a COMPLETED call we wait for that event; for a
 * non-conversation terminal outcome (no answer / busy / failed / canceled) no
 * analysis is expected, so we deliver on `call_ended`. `deliverCallNote` itself is
 * single-shot, status-tracked and never throws, and skips a record already sent.
 */
async function deliverCallNoteIfTerminal(
  eventName: string,
  record: CallRecord | undefined,
): Promise<void> {
  if (!record || !TERMINAL_CALL_STATUSES.has(record.status) || record.noteStatus === 'sent') return;
  const waitsForAnalysis = record.status === CallStatus.COMPLETED;
  if (waitsForAnalysis && eventName !== 'call_analyzed') return;

  try {
    await deliverCallNote(record);
  } catch (error) {
    logger.error(
      {
        callId: record.retellCallId,
        leadId: record.leadId,
        err: error instanceof Error ? error.name : 'unknown',
      },
      'CRM call-note delivery raised unexpectedly; webhook still acknowledged',
    );
  }
}

async function completeLeadIfCallTerminal(
  record: CallRecord | undefined,
  callId: string,
): Promise<void> {
  if (!record || !TERMINAL_CALL_STATUSES.has(record.status)) return;

  try {
    const completed = await completeCallingLead(record.leadId);
    logger.info(
      { callId, leadId: record.leadId, completed },
      completed
        ? 'lead processing completed after terminal call event'
        : 'terminal call event: lead already finished or advanced; no transition applied',
    );
  } catch (error) {
    // Do not fail the webhook: the call record is already updated. Log for a reaper
    // / later event to reconcile.
    logger.error(
      { callId, leadId: record.leadId, err: error instanceof Error ? error.name : 'unknown' },
      'failed to complete lead processing after terminal call event',
    );
  }
}
