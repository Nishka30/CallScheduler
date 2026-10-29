import type { CallRecord } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { CalendarClient } from '../integrations/leadApi/calendar.client.js';
import { LeadApiError, describeLeadApiError } from '../integrations/leadApi/errors.js';
import { findLatestAppointmentForLead } from '../repositories/appointmentRecord.repository.js';
import {
  markCallNoteDelivered,
  markCallNoteFailed,
} from '../repositories/callRecord.repository.js';
import {
  buildCallNote,
  type CallNoteAppointment,
  type CallNoteRecord,
} from './callNote.service.js';

/**
 * Delivers the CRM note for a completed call and records the delivery status on
 * the local call record — WITHOUT ever rolling back the call record or booking.
 *
 * Safety model:
 *   - The local call record is already persisted before this runs; a note failure
 *     only sets `noteStatus = 'failed'` (+ a sanitized category), never erases data.
 *   - SINGLE-SHOT: the CRM's idempotency support for notes is unconfirmed, so this
 *     never auto-retries a write that may already have landed (which would risk a
 *     duplicate note). A failed note is recorded and surfaced for reconciliation.
 *   - Delivered at most once per call: a record already `sent` is skipped.
 *   - Never throws — the caller (webhook) must still acknowledge delivery.
 *   - Never books or re-books anything; it only reads the latest appointment to
 *     include confirmed booking details in the note.
 */

export type NoteDeliveryResult = 'sent' | 'failed' | 'already_sent';

export interface NoteDeliveryDeps {
  client?: Pick<CalendarClient, 'postCallNote'>;
  findAppointment?: (leadId: string) => Promise<CallNoteAppointment | null>;
  markDelivered?: (id: string) => Promise<void>;
  markFailed?: (id: string, category: string) => Promise<void>;
}

export async function deliverCallNote(
  record: CallRecord,
  deps: NoteDeliveryDeps = {},
): Promise<NoteDeliveryResult> {
  if (record.noteStatus === 'sent') return 'already_sent';

  const client = deps.client ?? new CalendarClient();
  const findAppointment = deps.findAppointment ?? defaultFindAppointment;
  const markDelivered = deps.markDelivered ?? ((id: string) => markCallNoteDelivered(id));
  const markFailed = deps.markFailed ?? ((id: string, c: string) => markCallNoteFailed(id, c));

  const appointment = (await findAppointment(record.leadId)) ?? undefined;
  const { note } = buildCallNote(toNoteRecord(record), appointment);

  try {
    await client.postCallNote(record.leadId, note);
  } catch (error) {
    const category =
      error instanceof LeadApiError
        ? `${error.kind}${error.status === undefined ? '' : ` ${String(error.status)}`}`
        : 'unknown';
    const safe =
      error instanceof LeadApiError
        ? describeLeadApiError(error)
        : { kind: 'unknown', err: error instanceof Error ? error.name : 'unknown' };
    // Never log the note/transcript content.
    logger.warn(
      { callRecordId: record.id, leadId: record.leadId, ...safe },
      'CRM call-note delivery failed; local call record retained for reconciliation',
    );
    await markFailed(record.id, category);
    return 'failed';
  }

  await markDelivered(record.id);
  logger.info({ callRecordId: record.id, leadId: record.leadId }, 'CRM call-note delivered');
  return 'sent';
}

function toNoteRecord(r: CallRecord): CallNoteRecord {
  return {
    leadId: r.leadId,
    retellCallId: r.retellCallId,
    status: r.status,
    outcome: r.outcome,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    direction: r.direction,
    customerTz: r.customerTz,
    disconnectionReason: r.disconnectionReason,
    summary: r.summary,
    analysis: r.analysis,
    transcript: r.transcript,
    recordingUrl: r.recordingUrl,
  };
}

async function defaultFindAppointment(leadId: string): Promise<CallNoteAppointment | null> {
  const a = await findLatestAppointmentForLead(leadId);
  return a
    ? {
        appointmentId: a.appointmentId,
        startsAt: a.startsAt,
        status: a.status,
        meetingType: a.meetingType,
        agentEmail: a.agentEmail,
        decisionMode: a.decisionMode,
      }
    : null;
}
