import { describe, expect, it } from 'vitest';
import {
  buildCallNote,
  deriveCallOutcomeLabel,
  type CallNoteAppointment,
  type CallNoteRecord,
} from '../src/services/callNote.service.js';

function record(over: Partial<CallNoteRecord> = {}): CallNoteRecord {
  return {
    leadId: 'lead-1',
    retellCallId: 'call_abc',
    status: 'COMPLETED',
    outcome: null,
    startedAt: new Date('2026-10-30T09:00:00.000Z'),
    endedAt: new Date('2026-10-30T09:05:00.000Z'),
    direction: 'outbound',
    customerTz: 'America/Denver',
    disconnectionReason: null,
    summary: 'Discussed an Everest trek.',
    analysis: { user_sentiment: 'Positive' },
    transcript: 'Agent: Hello\nUser: Hi',
    recordingUrl: 'https://rec.example/abc.wav',
    ...over,
  };
}

const appointment: CallNoteAppointment = {
  appointmentId: 'appt_1',
  startsAt: new Date('2026-11-02T17:00:00.000Z'),
  status: 'booked',
  meetingType: 'video',
  agentEmail: 'agent@example.com',
  decisionMode: 'pool',
};

describe('deriveCallOutcomeLabel', () => {
  it('maps the supported outcomes', () => {
    expect(deriveCallOutcomeLabel({ status: 'COMPLETED', outcome: 'APPOINTMENT_BOOKED' })).toBe(
      'booked',
    );
    expect(deriveCallOutcomeLabel({ status: 'COMPLETED', outcome: 'CALLBACK_REQUESTED' })).toBe(
      'callback_requested',
    );
    expect(deriveCallOutcomeLabel({ status: 'COMPLETED', outcome: 'NOT_INTERESTED' })).toBe(
      'declined',
    );
    expect(deriveCallOutcomeLabel({ status: 'NO_ANSWER', outcome: 'NOT_REACHED' })).toBe(
      'no_answer',
    );
    expect(deriveCallOutcomeLabel({ status: 'FAILED', outcome: null })).toBe('failed');
    expect(deriveCallOutcomeLabel({ status: 'COMPLETED', outcome: null })).toBe('completed');
  });

  it('an existing booked appointment forces the booked outcome', () => {
    expect(deriveCallOutcomeLabel({ status: 'COMPLETED', outcome: null }, appointment)).toBe(
      'booked',
    );
  });
});

describe('buildCallNote', () => {
  it('a booked call includes the appointment details and the transcript', () => {
    const { outcome, note } = buildCallNote(record({ outcome: 'APPOINTMENT_BOOKED' }), appointment);
    expect(outcome).toBe('booked');
    expect(note).toContain('Outcome: booked');
    expect(note).toContain('Lead ID: lead-1');
    expect(note).toContain('Retell call ID: call_abc');
    expect(note).toContain('appt_1');
    expect(note).toContain('video');
    expect(note).toContain('Transcript:');
    expect(note).toContain('Agent: Hello');
  });

  it('a declined call records the outcome, summary and transcript (no appointment)', () => {
    const { outcome, note } = buildCallNote(record({ outcome: 'NOT_INTERESTED' }));
    expect(outcome).toBe('declined');
    expect(note).toContain('Outcome: declined');
    expect(note).not.toContain('Appointment:');
    expect(note).toContain('Discussed an Everest trek.');
  });

  it('a callback request is labelled accordingly', () => {
    const { outcome, note } = buildCallNote(record({ outcome: 'CALLBACK_REQUESTED' }));
    expect(outcome).toBe('callback_requested');
    expect(note).toContain('Outcome: callback_requested');
  });

  it('a no-answer call with no transcript marks it unavailable, never fabricated', () => {
    const { outcome, note } = buildCallNote(
      record({
        status: 'NO_ANSWER',
        outcome: 'NOT_REACHED',
        transcript: null,
        summary: null,
        analysis: null,
        recordingUrl: null,
        disconnectionReason: 'dial_no_answer',
      }),
    );
    expect(outcome).toBe('no_answer');
    expect(note).toContain('Disconnection reason: dial_no_answer');
    expect(note).toContain('Summary: (not available)');
    expect(note).toContain('Recording: (not available)');
    expect(note).toMatch(/Transcript:\n\(not available\)/);
  });

  it('a failed call is labelled failed', () => {
    expect(buildCallNote(record({ status: 'FAILED', outcome: null })).outcome).toBe('failed');
  });

  it('falls back to the analysis summary when no agent summary is present', () => {
    const { note } = buildCallNote(
      record({ summary: null, analysis: { call_summary: 'From analysis.' } }),
    );
    expect(note).toContain('Summary: From analysis.');
  });

  it('shows duration from start/end and marks it unavailable when a timestamp is missing', () => {
    expect(buildCallNote(record()).note).toContain('Duration: 300s');
    expect(buildCallNote(record({ endedAt: null })).note).toContain('Duration: (not available)');
  });
});
