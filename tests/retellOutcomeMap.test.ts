import { describe, expect, it } from 'vitest';
import { CallOutcome, CallStatus } from '@prisma/client';
import { mapRetellResult } from '../src/integrations/retell/outcomeMap.js';
import type { RetellWebhookEvent } from '../src/integrations/retell/webhookSchemas.js';

/**
 * The mapping is conservative by design (task §4). Provider call status is
 * separate from business outcome, and only unambiguous, authoritative signals
 * become a non-UNKNOWN outcome. A completed conversation, `call_successful`, or
 * sentiment NEVER yields INTERESTED / NOT_INTERESTED / APPOINTMENT_BOOKED.
 */
function event(name: string, call: Record<string, unknown> = {}): RetellWebhookEvent {
  return { event: name, call: { call_id: 'call_1', ...call } };
}

describe('mapRetellResult — provider call status', () => {
  it('maps call_started to IN_PROGRESS', () => {
    expect(mapRetellResult(event('call_started')).status).toBe(CallStatus.IN_PROGRESS);
  });

  it('maps call_status ongoing to IN_PROGRESS', () => {
    expect(mapRetellResult(event('call_ended', { call_status: 'ongoing' })).status).toBe(
      CallStatus.IN_PROGRESS,
    );
  });

  it('maps call_status ended to COMPLETED', () => {
    expect(mapRetellResult(event('call_ended', { call_status: 'ended' })).status).toBe(
      CallStatus.COMPLETED,
    );
  });

  it('maps call_status error to FAILED', () => {
    expect(mapRetellResult(event('call_ended', { call_status: 'error' })).status).toBe(
      CallStatus.FAILED,
    );
  });

  it('maps dial_no_answer / dial_busy to the specific telephony status', () => {
    expect(
      mapRetellResult(
        event('call_ended', { call_status: 'ended', disconnection_reason: 'dial_no_answer' }),
      ).status,
    ).toBe(CallStatus.NO_ANSWER);
    expect(
      mapRetellResult(
        event('call_ended', { call_status: 'ended', disconnection_reason: 'dial_busy' }),
      ).status,
    ).toBe(CallStatus.BUSY);
  });

  it('leaves an unrecognised / pre-call status as UNKNOWN', () => {
    expect(mapRetellResult(event('call_ended', { call_status: 'registered' })).status).toBe(
      CallStatus.UNKNOWN,
    );
    expect(mapRetellResult(event('call_ended', {})).status).toBe(CallStatus.UNKNOWN);
  });
});

describe('mapRetellResult — business outcome (conservative)', () => {
  it('maps voicemail_reached and in_voicemail to VOICEMAIL', () => {
    expect(
      mapRetellResult(event('call_ended', { disconnection_reason: 'voicemail_reached' })).outcome,
    ).toBe(CallOutcome.VOICEMAIL);
    expect(
      mapRetellResult(event('call_analyzed', { call_analysis: { in_voicemail: true } })).outcome,
    ).toBe(CallOutcome.VOICEMAIL);
  });

  it('maps no-answer and busy to NOT_REACHED', () => {
    expect(
      mapRetellResult(event('call_ended', { disconnection_reason: 'dial_no_answer' })).outcome,
    ).toBe(CallOutcome.NOT_REACHED);
    expect(
      mapRetellResult(event('call_ended', { disconnection_reason: 'dial_busy' })).outcome,
    ).toBe(CallOutcome.NOT_REACHED);
  });

  it('maps invalid_destination to WRONG_NUMBER', () => {
    expect(
      mapRetellResult(event('call_ended', { disconnection_reason: 'invalid_destination' })).outcome,
    ).toBe(CallOutcome.WRONG_NUMBER);
  });

  it('maps explicit DNC and callback requests', () => {
    expect(
      mapRetellResult(event('call_ended', { disconnection_reason: 'user_requested_dnc' })).outcome,
    ).toBe(CallOutcome.DO_NOT_CONTACT);
    expect(
      mapRetellResult(event('call_ended', { disconnection_reason: 'user_requested_callback' }))
        .outcome,
    ).toBe(CallOutcome.CALLBACK_REQUESTED);
  });

  it('NEVER infers a booking or interest from a completed call or call_successful', () => {
    const completed = event('call_analyzed', {
      call_status: 'ended',
      disconnection_reason: 'user_hangup',
      call_analysis: {
        call_successful: true,
        user_sentiment: 'Positive',
        call_summary: 'Booked a trek!',
      },
    });

    const result = mapRetellResult(completed);

    expect(result.status).toBe(CallStatus.COMPLETED);
    // Successful + positive + a summary mentioning booking must still be UNKNOWN:
    // a booking needs an authoritative Calendly result, not a transcript.
    expect(result.outcome).toBe(CallOutcome.UNKNOWN);
  });

  it('leaves agent/user hangup with no other signal as UNKNOWN outcome', () => {
    expect(
      mapRetellResult(
        event('call_ended', { call_status: 'ended', disconnection_reason: 'user_hangup' }),
      ).outcome,
    ).toBe(CallOutcome.UNKNOWN);
  });
});
