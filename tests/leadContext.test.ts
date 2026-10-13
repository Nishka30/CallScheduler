import { describe, expect, it, vi } from 'vitest';
import {
  buildLeadCallContext,
  describeContextForLog,
  summarizePersonHistory,
} from '../src/services/leadContext.service.js';
import type { LeadDetail } from '../src/integrations/leadApi/schemas.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

/** Mirrors the confirmed live shapes, with invented personal values. */
function detail(overrides: Partial<LeadDetail> = {}): LeadDetail {
  return {
    captured: {
      name: 'Jon Smith',
      brand: 'himalayan',
      country: 'United Kingdom',
      city: 'Leeds',
      free_text: 'Looking for a guided trek',
      email: 'jon@example.com',
      gclid: 'abc123',
    },
    current: { name: 'John Smyth' },
    personKey: 'lead:1',
    phone: {
      phone_raw: '07700900123',
      phone_e164: '+447700900123',
      phone_best: '+447700900123',
      valid: true,
      tier: 'live_mobile',
      line_type: 'mobile',
      country_iso: 'GB',
      lookup_status: 'ok',
    },
    answers: [
      {
        questionId: 'confirm_trek',
        prompt: 'What kind of Nepal trek?',
        answer: 'Everest Base Camp',
        position: 1,
      },
      { questionId: 'group_size', prompt: 'How many are in your group?', answer: '2', position: 2 },
      {
        questionId: 'trip_length',
        prompt: 'How long do you have?',
        answer: '2 weeks',
        position: 3,
      },
      {
        questionId: 'timing',
        prompt: 'When are you looking to start?',
        answer: 'March 2027',
        position: 4,
      },
      { questionId: 'experience', prompt: 'How much experience?', answer: 'Some', position: 5 },
      {
        questionId: 'been_before',
        prompt: 'Been trekking in Nepal before?',
        answer: 'No',
        position: 6,
      },
    ],
    ...overrides,
  };
}

describe('buildLeadCallContext', () => {
  it('prefers corrected current values over captured ones', () => {
    const context = buildLeadCallContext('1', detail());

    // `current` carries the correction; `captured` is never rewritten.
    expect(context.customerName).toBe('John Smyth');
    expect(detail().captured!.name).toBe('Jon Smith');
  });

  it('falls back to a captured value when current omits the column', () => {
    const context = buildLeadCallContext('1', detail());

    expect(context.country).toBe('United Kingdom');
    expect(context.city).toBe('Leeds');
    expect(context.brand).toBe('himalayan');
  });

  it('lifts travel intent from the confirmed questionnaire ids', () => {
    const context = buildLeadCallContext('1', detail());

    // Travel details live in answers[], not in lead columns.
    expect(context.trek).toBe('Everest Base Camp');
    expect(context.groupSize).toBe('2');
    expect(context.tripLength).toBe('2 weeks');
    expect(context.timing).toBe('March 2027');
    expect(context.experience).toBe('Some');
    expect(context.beenBefore).toBe('No');
  });

  it('keeps every answer whole alongside the mapped fields', () => {
    const context = buildLeadCallContext('1', detail());

    expect(context.answers).toHaveLength(6);
    expect(context.answers[0]).toMatchObject({
      questionId: 'confirm_trek',
      prompt: 'What kind of Nepal trek?',
      answer: 'Everest Base Camp',
    });
  });

  it('drops malformed answers rather than guessing them', () => {
    const context = buildLeadCallContext(
      '1',
      detail({
        answers: [{ questionId: 'x' }, null, 'nope', { questionId: 'a', prompt: 'p', answer: 'v' }],
      }),
    );

    expect(context.answers).toHaveLength(1);
  });

  it('surfaces a parsable caller_hold_until verbatim', () => {
    const context = buildLeadCallContext(
      '1',
      detail({ captured: { ...detail().captured, caller_hold_until: '2026-10-14T18:00:00.000Z' } }),
    );

    expect(context.callerHoldUntil).toBe('2026-10-14T18:00:00.000Z');
  });

  it('omits an unparsable caller_hold_until rather than passing it through', () => {
    const context = buildLeadCallContext(
      '1',
      detail({ captured: { ...detail().captured, caller_hold_until: 'not-a-date' } }),
    );

    expect(context.callerHoldUntil).toBeUndefined();
  });

  it('omits caller_hold_until when absent, and never duplicates it into leadFields', () => {
    const context = buildLeadCallContext('1', detail());

    expect(context.callerHoldUntil).toBeUndefined();
    expect(context.leadFields).not.toHaveProperty('caller_hold_until');
  });

  it('includes the validated phone number and its verdict metadata', () => {
    const context = buildLeadCallContext('1', detail());

    expect(context.phoneE164).toBe('+447700900123');
    expect(context.phoneTier).toBe('live_mobile');
    expect(context.phoneLineType).toBe('mobile');
  });

  it('omits the phone number when the number was never validated', () => {
    // The live "not validated" shape: valid null, tier none.
    const context = buildLeadCallContext(
      '1',
      detail({ phone: { phone_raw: '07700900123', phone_e164: null, valid: null, tier: 'none' } }),
    );

    expect(context.phoneE164).toBeUndefined();
  });

  it('never falls back to phone_raw or phone_best', () => {
    const context = buildLeadCallContext(
      '1',
      detail({
        phone: {
          phone_raw: '07700900123',
          phone_best: '+447700900123',
          phone_e164: null,
          valid: null,
        },
      }),
    );

    expect(context.phoneE164).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain('07700900123');
  });

  it('invents nothing when fields are absent', () => {
    const context = buildLeadCallContext('1', {
      captured: {},
      current: {},
      phone: undefined,
      answers: [],
    });

    expect(context.customerName).toBeUndefined();
    expect(context.trek).toBeUndefined();
    expect(context.timing).toBeUndefined();
    expect(context.answers).toEqual([]);
  });

  it('excludes contact and attribution columns from the copied lead fields', () => {
    const context = buildLeadCallContext('1', detail());

    expect(context.leadFields).not.toHaveProperty('email');
    expect(context.leadFields).not.toHaveProperty('gclid');
    expect(context.leadFields).not.toHaveProperty('whatsapp');
    expect(context.leadFields).not.toHaveProperty('session_id');
    expect(context.leadFields.country).toBe('United Kingdom');
  });

  it('takes the person key from the list row when the detail omits it', () => {
    const context = buildLeadCallContext('1', detail({ personKey: null }), {
      listRow: { id: '1', updated_at: 'x', person_key: 'email:a@example.com' },
    });

    expect(context.personKey).toBe('email:a@example.com');
  });

  it('drops nested objects rather than copying raw payloads', () => {
    const context = buildLeadCallContext(
      '1',
      detail({ captured: { raw_payload: { secret: 'value' }, country: 'Nepal' } }),
    );

    expect(context.leadFields).not.toHaveProperty('raw_payload');
    expect(JSON.stringify(context.leadFields)).not.toContain('secret');
  });
});

describe('summarizePersonHistory', () => {
  it('condenses the confirmed profile shape into counts and routing info', () => {
    const summary = summarizePersonHistory({
      profile: {
        salesAgent: { email: 'raine@example.com', name: 'Raine' },
        leadStatus: 'Engaged',
        counts: { inquiries: 2, calls: 4, payments: 0 },
      },
      leads: [{}, {}],
      bookings: [{}],
      notes: [{}, {}, {}],
    });

    expect(summary).toEqual({
      priorInquiryCount: 2,
      bookingCount: 1,
      noteCount: 3,
      priorCallCount: 4,
      currentAgentEmail: 'raine@example.com',
      currentStatus: 'Engaged',
    });
  });

  it('accepts a bare string sales agent, whose shape is unconfirmed', () => {
    const summary = summarizePersonHistory({
      profile: { salesAgent: 'raine@example.com' },
    });

    expect(summary.currentAgentEmail).toBe('raine@example.com');
  });

  it('handles the common all-null profile without inventing values', () => {
    // Matches the live data: salesAgent and leadStatus are usually null.
    const summary = summarizePersonHistory({
      profile: { salesAgent: null, leadStatus: null, counts: null },
    });

    expect(summary).toEqual({ priorInquiryCount: 0, bookingCount: 0, noteCount: 0 });
  });

  it('handles an empty profile', () => {
    expect(summarizePersonHistory({})).toEqual({
      priorInquiryCount: 0,
      bookingCount: 0,
      noteCount: 0,
    });
  });
});

describe('describeContextForLog', () => {
  it('emits presence flags and counts, never personal values', () => {
    const context = buildLeadCallContext('1', detail(), {
      history: {
        profile: { salesAgent: { email: 'raine@example.com' }, counts: { calls: 1 } },
        leads: [{}],
      },
    });

    const logged = JSON.stringify(describeContextForLog(context));

    expect(logged).not.toContain('John Smyth');
    expect(logged).not.toContain('447700900123');
    expect(logged).not.toContain('raine@example.com');
    expect(logged).not.toContain('Everest Base Camp');
    expect(logged).not.toContain('Leeds');
    expect(describeContextForLog(context)).toMatchObject({
      leadId: '1',
      hasValidatedPhone: true,
      phoneTier: 'live_mobile',
      hasName: true,
      hasTrek: true,
      answerCount: 6,
      priorCalls: 1,
    });
  });
});
