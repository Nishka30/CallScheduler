import { CallStatus, type CallRecord } from '@prisma/client';
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

  logger.info(
    { event: event.event, callId: call.call_id, changed: result.changed },
    'retell webhook applied',
  );
  return { status: 'processed', event: event.event, callId: call.call_id, changed: result.changed };
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
