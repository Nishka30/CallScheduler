import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  processBookingFunction,
  type BookingFunctionDeps,
} from '../src/services/retellBookingFunction.service.js';
import type { SlotOffer } from '../src/services/teamScheduling.service.js';
import type { BookingRequest, BookingResult } from '../src/services/appointmentBooking.service.js';
import { LeadApiError } from '../src/integrations/leadApi/errors.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const API_KEY = 'test-retell-key';
const CALL_ID = 'call_abc123';
const LEAD_ID = 'lead-real';

/** A valid Retell-style signature for a body, using the shared HMAC scheme. */
function sign(rawBody: string, now = Date.now()): string {
  const ts = now;
  const digest = createHmac('sha256', API_KEY)
    .update(rawBody + String(ts))
    .digest('hex');
  return `v=${ts},d=${digest}`;
}

function body(name: string | undefined, args: Record<string, unknown>, extra: object = {}): string {
  return JSON.stringify({ call: { call_id: CALL_ID, ...extra }, name, args });
}

function offer(overrides: Partial<SlotOffer> = {}): SlotOffer {
  return {
    mode: 'pool',
    fallback: false,
    slots: [
      { startsAt: '2026-10-25T09:00:00.000Z', local: 'Sun 25 Oct, 2:45 PM', agents: ['a@hw.com'] },
      { startsAt: '2026-10-25T10:00:00.000Z', local: 'Sun 25 Oct, 3:45 PM' },
    ],
    ...overrides,
  };
}

const booked: BookingResult = { outcome: 'booked', appointmentId: 'appt-1', agentName: 'Raine' };

/** Deps that always authenticate and bind to LEAD_ID, overridable per test. */
function deps(overrides: Partial<BookingFunctionDeps> = {}): BookingFunctionDeps {
  return {
    verify: () => true,
    findCallByProviderId: () => Promise.resolve({ leadId: LEAD_ID }),
    findExistingAppointment: () => Promise.resolve(null),
    offerSlots: () => Promise.resolve(offer()),
    book: () => Promise.resolve(booked),
    ...overrides,
  };
}

function input(rawBody: string, signature: string | undefined = sign(rawBody)) {
  return { rawBody, signature, apiKey: API_KEY };
}

/** A typed, inspectable `book` mock. */
function bookMock(result: BookingResult = booked) {
  return vi.fn((_request: BookingRequest): Promise<BookingResult> => Promise.resolve(result));
}

describe('processBookingFunction — authentication', () => {
  it('fails closed (misconfigured) when no API key is configured', async () => {
    const raw = body('get_available_slots', { timezone: 'Asia/Kolkata' });
    const res = await processBookingFunction(
      { rawBody: raw, signature: sign(raw), apiKey: undefined },
      deps(),
    );
    expect(res.status).toBe('misconfigured');
  });

  it('rejects a missing signature', async () => {
    const raw = body('get_available_slots', { timezone: 'Asia/Kolkata' });
    const res = await processBookingFunction(
      { rawBody: raw, signature: undefined, apiKey: API_KEY },
      deps(),
    );
    expect(res.status).toBe('unauthorized');
  });

  it('rejects an invalid signature (using the real verifier)', async () => {
    const raw = body('get_available_slots', { timezone: 'Asia/Kolkata' });
    // No verify override → real verifyRetellSignature; signature is forged.
    const res = await processBookingFunction(
      { rawBody: raw, signature: 'v=123,d=deadbeef', apiKey: API_KEY },
      { findCallByProviderId: () => Promise.resolve({ leadId: LEAD_ID }) },
    );
    expect(res.status).toBe('unauthorized');
  });

  it('accepts a correctly signed request with the real verifier', async () => {
    const raw = body('get_available_slots', { timezone: 'Asia/Kolkata' });
    const res = await processBookingFunction(input(raw), {
      findCallByProviderId: () => Promise.resolve({ leadId: LEAD_ID }),
      offerSlots: () => Promise.resolve(offer()),
    });
    expect(res.status).toBe('ok');
  });
});

describe('processBookingFunction — request validation & binding', () => {
  it('400s on a non-JSON body', async () => {
    const res = await processBookingFunction(
      { rawBody: '{nope', signature: sign('{nope'), apiKey: API_KEY },
      deps(),
    );
    expect(res.status).toBe('bad_request');
  });

  it('400s on an unsupported function name', async () => {
    const raw = body('transfer_money', { timezone: 'Asia/Kolkata' });
    const res = await processBookingFunction(input(raw), deps());
    expect(res.status).toBe('bad_request');
  });

  it('refuses when the call id is not associated with a known lead', async () => {
    const raw = body('get_available_slots', { timezone: 'Asia/Kolkata' });
    const res = await processBookingFunction(
      input(raw),
      deps({ findCallByProviderId: () => Promise.resolve(null) }),
    );
    expect(res.status).toBe('unknown_call');
  });

  it('refuses when metadata lead id disagrees with the call record (defence in depth)', async () => {
    const raw = body(
      'book_consultation',
      { timezone: 'UTC', starts_at: 'x', confirmed: true, confirmed_destination: 'Nepal' },
      { metadata: { leadId: 'someone-else' } },
    );
    const res = await processBookingFunction(input(raw), deps());
    expect(res.status).toBe('unknown_call');
  });
});

describe('processBookingFunction — get_available_slots', () => {
  it('returns only times (never agent emails) on availability', async () => {
    const raw = body('get_available_slots', { timezone: 'Asia/Kolkata' });
    const res = await processBookingFunction(input(raw), deps());
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.available).toBe(true);
    const serialized = JSON.stringify(res.payload);
    expect(serialized).not.toContain('a@hw.com');
    expect(serialized).not.toContain('agents');
    expect(res.payload.slots).toEqual([
      { starts_at: '2026-10-25T09:00:00.000Z', local: 'Sun 25 Oct, 2:45 PM' },
      { starts_at: '2026-10-25T10:00:00.000Z', local: 'Sun 25 Oct, 3:45 PM' },
    ]);
  });

  it('reports no availability for mode=none without offering a slot', async () => {
    const raw = body('get_available_slots', { timezone: 'Asia/Kolkata' });
    const res = await processBookingFunction(
      input(raw),
      deps({ offerSlots: () => Promise.resolve(offer({ mode: 'none', slots: [] })) }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.available).toBe(false);
  });

  it('asks for a timezone when it is missing, rather than erroring out', async () => {
    const raw = body('get_available_slots', {});
    const res = await processBookingFunction(input(raw), deps());
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.available).toBe(false);
    expect(String(res.payload.error)).toMatch(/timezone/i);
  });

  it('degrades gracefully (no 500) when the team-slots response fails the schema', async () => {
    const raw = body('get_available_slots', { timezone: 'Asia/Kolkata' });
    const contractError = new LeadApiError(
      'contract',
      'team-slots response did not match the documented shape',
      { path: '/api/crm/leads/lead-real/team-slots', issues: ['slots.0.starts_at: invalid_type'] },
    );
    const res = await processBookingFunction(
      input(raw),
      deps({ offerSlots: () => Promise.reject(contractError) }),
    );
    expect(res.status).toBe('ok'); // HTTP 200, not a thrown 500
    if (res.status !== 'ok') return;
    expect(res.payload.available).toBe(false);
    // The agent gets a friendly fallback — never the raw contract/internal detail.
    const serialized = JSON.stringify(res.payload);
    expect(serialized).not.toContain('documented shape');
    expect(serialized).not.toContain('invalid_type');
    expect(res.payload.slots).toBeUndefined(); // never fabricate slots
  });

  it('degrades gracefully when the team-slots read returns an upstream 400', async () => {
    // A valid, normalised tz still reaches the CRM; an upstream 400 must degrade.
    const raw = body('get_available_slots', { timezone: 'Asia/Kolkata' });
    const badReq = new LeadApiError(
      'client',
      'calendar GET /api/crm/leads/lead-real/team-slots returned 400: bad request',
      { status: 400, path: '/api/crm/leads/lead-real/team-slots' },
    );
    const res = await processBookingFunction(
      input(raw),
      deps({ offerSlots: () => Promise.reject(badReq) }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.available).toBe(false);
    // Never leak the upstream status/path/detail to the model.
    const serialized = JSON.stringify(res.payload);
    expect(serialized).not.toContain('400');
    expect(serialized).not.toContain('/api/crm');
  });

  it('normalises an alias/offset timezone to IANA before calling the CRM', async () => {
    // "GMT+5:30" → Asia/Kolkata (the CRM 400s on the raw form).
    const raw = body('get_available_slots', { timezone: 'GMT+5:30' });
    let seenTz: string | undefined;
    const res = await processBookingFunction(
      input(raw),
      deps({
        offerSlots: (_lead, tz) => {
          seenTz = tz;
          return Promise.resolve(offer());
        },
      }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(seenTz).toBe('Asia/Kolkata'); // the CRM never sees "GMT+5:30"
    expect(res.payload.available).toBe(true);
  });

  it('asks again (never calls the CRM) for an unknown timezone', async () => {
    const raw = body('get_available_slots', { timezone: 'invalid-zone' });
    const spy = vi.fn((_lead: string, _tz: string) => Promise.resolve(offer()));
    const res = await processBookingFunction(input(raw), deps({ offerSlots: spy }));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.available).toBe(false);
    expect(String(res.payload.error)).toMatch(/timezone/i);
    expect(spy).not.toHaveBeenCalled(); // short-circuited; no wasted CRM 400
  });

  it('degrades gracefully when the team-slots read times out', async () => {
    const raw = body('get_available_slots', { timezone: 'Asia/Kolkata' });
    const timeout = new LeadApiError('network', 'calendar request timed out after 8000ms', {
      path: '/api/crm/leads/lead-real/team-slots',
    });
    const res = await processBookingFunction(
      input(raw),
      deps({ offerSlots: () => Promise.reject(timeout) }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.available).toBe(false);
  });
});

describe('processBookingFunction — book_consultation', () => {
  const okArgs = {
    timezone: 'Asia/Kolkata',
    starts_at: '2026-10-25T09:00:00.000Z',
    confirmed: true,
    confirmed_destination: 'Nepal',
    preferred_trek: 'Everest region',
    trip_duration: '8–11 days',
  };

  it('books and returns the appointment and consultant on success', async () => {
    const raw = body('book_consultation', okArgs);
    let captured: BookingRequest | undefined;
    const res = await processBookingFunction(
      input(raw),
      deps({
        book: (req) => {
          captured = req;
          return Promise.resolve({
            outcome: 'booked',
            appointmentId: 'appt-9',
            agentName: 'Raine',
          });
        },
      }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload).toMatchObject({
      booked: true,
      appointment_id: 'appt-9',
      consultant: 'Raine',
    });
    expect(captured?.notes).toContain('Nepal');
    expect(captured?.customerAgreed).toBe(true);
  });

  it('binds the booking to the call-record lead, never a lead id from args', async () => {
    const raw = body('book_consultation', {
      ...okArgs,
      lead_id: 'attacker-lead',
      leadId: 'attacker-lead',
    });
    let captured: BookingRequest | undefined;
    const res = await processBookingFunction(
      input(raw),
      deps({
        book: (req) => {
          captured = req;
          return Promise.resolve({ outcome: 'booked', appointmentId: 'a' });
        },
      }),
    );
    expect(res.status).toBe('ok');
    expect(captured?.leadId).toBe(LEAD_ID);
  });

  it('records a confirmed destination change in the note', async () => {
    const raw = body('book_consultation', {
      ...okArgs,
      confirmed_destination: 'Patagonia',
      destination_changed_from: 'Nepal',
    });
    let captured: BookingRequest | undefined;
    const res = await processBookingFunction(
      input(raw),
      deps({
        book: (req) => {
          captured = req;
          return Promise.resolve({ outcome: 'booked', appointmentId: 'a' });
        },
      }),
    );
    expect(res.status).toBe('ok');
    expect(captured?.notes).toContain('Patagonia');
    expect(captured?.notes.toLowerCase()).toContain('change');
    expect(captured?.notes).toContain('Nepal');
  });

  it('refuses to book when the agent has not confirmed', async () => {
    const raw = body('book_consultation', { ...okArgs, confirmed: false });
    const spy = bookMock();
    const res = await processBookingFunction(input(raw), deps({ book: spy }));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.booked).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to book when the confirmed destination is missing', async () => {
    const raw = body('book_consultation', {
      timezone: 'Asia/Kolkata',
      starts_at: 'x',
      confirmed: true,
    });
    const spy = bookMock();
    const res = await processBookingFunction(input(raw), deps({ book: spy }));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.booked).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is idempotent: an existing appointment is returned without booking again', async () => {
    const raw = body('book_consultation', okArgs);
    const spy = bookMock();
    const res = await processBookingFunction(
      input(raw),
      deps({
        findExistingAppointment: () =>
          Promise.resolve({
            appointmentId: 'appt-existing',
            startsAt: new Date('2026-10-25T09:00:00.000Z'),
          }),
        book: spy,
      }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload).toMatchObject({
      booked: true,
      already_booked: true,
      appointment_id: 'appt-existing',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('(5) is idempotent after a reconciled booking: a later call returns already_booked without re-booking', async () => {
    // Once reconciliation has persisted the appointment, the idempotency guard
    // short-circuits any further book_consultation for this lead.
    const raw = body('book_consultation', okArgs);
    const offerSpy = vi.fn((_lead: string, _tz: string) => Promise.resolve(offer()));
    const bookSpy = bookMock();
    const res = await processBookingFunction(
      input(raw),
      deps({
        findExistingAppointment: () =>
          Promise.resolve({
            appointmentId: 'appt_real',
            startsAt: new Date('2026-10-25T09:00:00.000Z'),
          }),
        offerSlots: offerSpy,
        book: bookSpy,
      }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload).toMatchObject({
      booked: true,
      already_booked: true,
      appointment_id: 'appt_real',
      starts_at: '2026-10-25T09:00:00.000Z',
    });
    expect(offerSpy).not.toHaveBeenCalled(); // no fresh availability read
    expect(bookSpy).not.toHaveBeenCalled(); // never re-books
  });

  it('does not claim success and does not rebook on an uncertain upstream result', async () => {
    const raw = body('book_consultation', okArgs);
    const res = await processBookingFunction(
      input(raw),
      deps({ book: () => Promise.resolve({ outcome: 'uncertain', reason: 'timeout' }) }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.booked).toBe(false);
    expect(String(res.payload.reason).toLowerCase()).toMatch(/again|finalis|confirm/);
  });

  it('maps a slot conflict to a safe "offer another time" message', async () => {
    const raw = body('book_consultation', okArgs);
    const res = await processBookingFunction(
      input(raw),
      deps({ book: () => Promise.resolve({ outcome: 'slot_conflict' }) }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.booked).toBe(false);
    expect(String(res.payload.reason)).toMatch(/another time/i);
  });

  it('never exposes the 403 scope detail to the model on write_scope_disabled', async () => {
    const raw = body('book_consultation', okArgs);
    const res = await processBookingFunction(
      input(raw),
      deps({ book: () => Promise.resolve({ outcome: 'write_scope_disabled' }) }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.booked).toBe(false);
    const serialized = JSON.stringify(res.payload);
    expect(serialized).not.toContain('403');
    expect(serialized.toLowerCase()).not.toContain('scope');
  });

  it('maps routing_none to a take-details follow-up', async () => {
    const raw = body('book_consultation', okArgs);
    const res = await processBookingFunction(
      input(raw),
      deps({ book: () => Promise.resolve({ outcome: 'routing_none' }) }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.booked).toBe(false);
    expect(String(res.payload.reason).toLowerCase()).toContain('follow');
  });

  it('normalises the timezone for booking (alias → IANA) and preserves the UTC starts_at', async () => {
    const raw = body('book_consultation', { ...okArgs, timezone: 'India Standard Time' });
    let captured: BookingRequest | undefined;
    let offerTz: string | undefined;
    const res = await processBookingFunction(
      input(raw),
      deps({
        offerSlots: (_lead, tz) => {
          offerTz = tz;
          return Promise.resolve(offer());
        },
        book: (req) => {
          captured = req;
          return Promise.resolve({ outcome: 'booked', appointmentId: 'a' });
        },
      }),
    );
    expect(res.status).toBe('ok');
    expect(offerTz).toBe('Asia/Kolkata');
    expect(captured?.customerTz).toBe('Asia/Kolkata'); // normalised IANA
    expect(captured?.chosenStartsAt).toBe('2026-10-25T09:00:00.000Z'); // UTC untouched
  });

  it('refuses to book (and never calls the CRM) for an unknown timezone', async () => {
    const raw = body('book_consultation', { ...okArgs, timezone: 'invalid-zone' });
    const offerSpy = vi.fn((_lead: string, _tz: string) => Promise.resolve(offer()));
    const bookSpy = bookMock();
    const res = await processBookingFunction(
      input(raw),
      deps({ offerSlots: offerSpy, book: bookSpy }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.payload.booked).toBe(false);
    expect(String(res.payload.reason)).toMatch(/timezone/i);
    expect(offerSpy).not.toHaveBeenCalled();
    expect(bookSpy).not.toHaveBeenCalled();
  });

  it('degrades gracefully (no 500, no booking) when the fresh-availability read fails', async () => {
    const raw = body('book_consultation', okArgs);
    const spy = bookMock();
    const res = await processBookingFunction(
      input(raw),
      deps({
        offerSlots: () =>
          Promise.reject(
            new LeadApiError('contract', 'team-slots response did not match the documented shape', {
              path: '/api/crm/leads/lead-real/team-slots',
            }),
          ),
        book: spy,
      }),
    );
    expect(res.status).toBe('ok'); // HTTP 200, not a thrown 500
    if (res.status !== 'ok') return;
    expect(res.payload.booked).toBe(false);
    expect(spy).not.toHaveBeenCalled(); // never book without verified fresh availability
    const serialized = JSON.stringify(res.payload);
    expect(serialized).not.toContain('documented shape');
  });
});
