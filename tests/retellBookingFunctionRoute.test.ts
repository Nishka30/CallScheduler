import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { BookingFunctionResult } from '../src/services/retellBookingFunction.service.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

// Mock the service so these tests isolate the HTTP layer: raw-body capture,
// header reading, and result -> status-code mapping.
const processBookingFunction = vi.fn<(...args: unknown[]) => Promise<BookingFunctionResult>>();
vi.mock('../src/services/retellBookingFunction.service.js', () => ({
  processBookingFunction: (...args: unknown[]) => processBookingFunction(...args),
}));

const { createApp } = await import('../src/app.js');
const app = createApp();

const BODY = '{"call":{"call_id":"call_1"},"name":"get_available_slots","args":{"timezone":"UTC"}}';

afterEach(() => {
  processBookingFunction.mockReset();
});

function post() {
  return request(app)
    .post('/webhooks/retell/booking')
    .set('Content-Type', 'application/json')
    .set('x-retell-signature', 'v=123,d=deadbeef')
    .send(BODY);
}

describe('POST /webhooks/retell/booking', () => {
  it('passes the EXACT raw body and signature header to the service', async () => {
    processBookingFunction.mockResolvedValue({
      status: 'ok',
      operation: 'get_slots',
      payload: { available: true, slots: [] },
    });

    await post();

    const arg = processBookingFunction.mock.calls[0]![0] as { rawBody: string; signature: string };
    expect(arg.rawBody).toBe(BODY); // raw, not re-serialised
    expect(arg.signature).toBe('v=123,d=deadbeef');
  });

  it('returns 200 with the tool payload on ok', async () => {
    processBookingFunction.mockResolvedValue({
      status: 'ok',
      operation: 'book',
      payload: { booked: true, appointment_id: 'appt-1' },
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ booked: true, appointment_id: 'appt-1' });
  });

  it('maps unauthorized -> 401', async () => {
    processBookingFunction.mockResolvedValue({
      status: 'unauthorized',
      reason: 'invalid signature',
    });
    const res = await post();
    expect(res.status).toBe(401);
  });

  it('maps unknown_call -> 403', async () => {
    processBookingFunction.mockResolvedValue({ status: 'unknown_call', reason: 'no lead' });
    const res = await post();
    expect(res.status).toBe(403);
  });

  it('maps misconfigured -> 503 and bad_request -> 400', async () => {
    processBookingFunction.mockResolvedValue({ status: 'misconfigured', reason: 'no key' });
    expect((await post()).status).toBe(503);

    processBookingFunction.mockResolvedValue({ status: 'bad_request', reason: 'bad' });
    expect((await post()).status).toBe(400);
  });
});
