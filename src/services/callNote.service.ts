/**
 * Builds the structured CRM note for a completed call, for EVERY outcome (booked,
 * declined, no-answer, failed, callback requested, …) — not just bookings.
 *
 * Pure and side-effect free: it takes a plain view of the local call record (and
 * the booked appointment when one exists) and returns the outcome label plus the
 * note text. It never fabricates data — anything missing is shown as
 * "(not available)" — and it carries no secrets (no API key, no phone/WhatsApp
 * number; those are never on the call record). The transcript/summary it includes
 * is the conversation content the CRM note is meant to carry; callers must NOT log
 * the returned note.
 */

export interface CallNoteRecord {
  leadId: string;
  retellCallId: string | null;
  /** `CallStatus` value as a string. */
  status: string;
  /** `CallOutcome` value as a string, or null. */
  outcome: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  direction: string | null;
  customerTz: string | null;
  disconnectionReason: string | null;
  summary: string | null;
  /** Structured Retell analysis (read defensively). */
  analysis: unknown;
  transcript: string | null;
  recordingUrl: string | null;
}

export interface CallNoteAppointment {
  appointmentId: string;
  startsAt: Date | null;
  status: string | null;
  meetingType: string | null;
  agentEmail: string | null;
  decisionMode: string | null;
}

export interface BuiltCallNote {
  /** Stable outcome label: booked | declined | callback_requested | no_answer | voicemail | failed | completed. */
  outcome: string;
  note: string;
}

const NA = '(not available)';

/**
 * Derives a single accurate outcome label from the call status/outcome and
 * whether a booking exists. Only maps to labels the provider data supports.
 */
export function deriveCallOutcomeLabel(
  record: Pick<CallNoteRecord, 'status' | 'outcome'>,
  appointment?: CallNoteAppointment,
): string {
  if (appointment && (appointment.status ?? 'booked').toLowerCase() === 'booked') return 'booked';

  switch (record.outcome) {
    case 'APPOINTMENT_BOOKED':
      return 'booked';
    case 'CALLBACK_REQUESTED':
      return 'callback_requested';
    case 'DO_NOT_CONTACT':
    case 'NOT_INTERESTED':
      return 'declined';
    case 'VOICEMAIL':
      return 'voicemail';
    default:
      break;
  }

  switch (record.status) {
    case 'NO_ANSWER':
    case 'BUSY':
      return 'no_answer';
    case 'FAILED':
    case 'CANCELED':
      return 'failed';
    default:
      return 'completed';
  }
}

function fmt(ts: Date | null): string {
  return ts ? ts.toISOString() : NA;
}

function durationSeconds(start: Date | null, end: Date | null): string {
  if (!start || !end) return NA;
  const s = Math.round((end.getTime() - start.getTime()) / 1000);
  return s >= 0 ? `${String(s)}s` : NA;
}

/** Reads a string field from the (untyped) analysis object without assuming its shape. */
function analysisString(analysis: unknown, key: string): string | undefined {
  if (analysis === null || typeof analysis !== 'object') return undefined;
  const value = (analysis as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function buildCallNote(
  record: CallNoteRecord,
  appointment?: CallNoteAppointment,
): BuiltCallNote {
  const outcome = deriveCallOutcomeLabel(record, appointment);
  const sentiment = analysisString(record.analysis, 'user_sentiment');
  const analysisSummary = analysisString(record.analysis, 'call_summary');
  const summary = record.summary ?? analysisSummary;

  const lines: string[] = [
    'AI caller call record.',
    `Outcome: ${outcome}.`,
    `Lead ID: ${record.leadId}.`,
    `Retell call ID: ${record.retellCallId ?? NA}.`,
    `Direction: ${record.direction ?? 'outbound'}. Call status: ${record.status}.`,
    `Started: ${fmt(record.startedAt)}. Ended: ${fmt(record.endedAt)}. Duration: ${durationSeconds(
      record.startedAt,
      record.endedAt,
    )}. Timezone: ${record.customerTz ?? NA}.`,
  ];

  if (record.disconnectionReason)
    lines.push(`Disconnection reason: ${record.disconnectionReason}.`);
  if (sentiment) lines.push(`Customer sentiment: ${sentiment}.`);

  if (outcome === 'booked' && appointment) {
    lines.push(
      `Appointment: ${fmt(appointment.startsAt)} (${appointment.meetingType ?? NA}) with ${
        appointment.agentEmail ?? NA
      }; status ${appointment.status ?? NA}; id ${appointment.appointmentId}.`,
    );
  } else if (outcome === 'booked') {
    lines.push('Appointment: booking reported but appointment details not available.');
  }

  lines.push(`Summary: ${summary ?? NA}`);
  lines.push(record.recordingUrl ? `Recording: ${record.recordingUrl}` : `Recording: ${NA}`);
  lines.push('');
  lines.push('Transcript:');
  lines.push(record.transcript && record.transcript.length > 0 ? record.transcript : NA);

  return { outcome, note: lines.join('\n') };
}
