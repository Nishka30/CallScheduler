import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { WebhookResult } from '../src/services/retellWebhook.service.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

// Mock the service so these tests isolate the HTTP layer: raw-body capture,
// header reading, and result -> status-code mapping.
const processRetellWebhook = vi.fn<(...args: unknown[]) => Promise<WebhookResult>>();
vi.mock('../src/services/retellWebhook.service.js', () => ({
  processRetellWebhook: (...args: unknown[]) => processRetellWebhook(...args),
}));

const { createApp } = await import('../src/app.js');
const app = createApp();

const BODY = '{"event":"call_ended","call":{"call_id":"call_1"}}';

afterEach(() => {
  processRetellWebhook.mockReset();
});

function post() {
  return request(app)
    .post('/webhooks/retell')
    .set('Content-Type', 'application/json')
    .set('x-retell-signature', 'v=123,d=deadbeef')
    .send(BODY);
}

describe('POST /webhooks/retell', () => {
  it('passes the EXACT raw body and signature header to the service', async () => {
    processRetellWebhook.mockResolvedValue({
      status: 'processed',
      event: 'call_ended',
      callId: 'call_1',
      changed: true,
    });

    await post();

    const arg = processRetellWebhook.mock.calls[0]![0] as {
      rawBody: string;
      signature: string;
    };
    expect(arg.rawBody).toBe(BODY); // raw, not re-serialised
    expect(arg.signature).toBe('v=123,d=deadbeef');
  });

  it('returns 200 with an empty body on processed', async () => {
    processRetellWebhook.mockResolvedValue({
      status: 'processed',
      event: 'call_ended',
      callId: 'call_1',
      changed: true,
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
  });

  it('returns 200 for ignored (unsupported) and unmatched events (no retry)', async () => {
    processRetellWebhook.mockResolvedValue({ status: 'ignored', event: 'transcript_updated' });
    expect((await post()).status).toBe(200);

    processRetellWebhook.mockResolvedValue({
      status: 'unmatched',
      event: 'call_ended',
      callId: 'x',
    });
    expect((await post()).status).toBe(200);
  });

  it('returns 401 on an unauthorized (missing/invalid signature) result', async () => {
    processRetellWebhook.mockResolvedValue({ status: 'unauthorized', reason: 'invalid signature' });
    expect((await post()).status).toBe(401);
  });

  it('returns 503 when verification is misconfigured (fail closed)', async () => {
    processRetellWebhook.mockResolvedValue({ status: 'misconfigured', reason: 'no secret' });
    expect((await post()).status).toBe(503);
  });

  it('returns 400 on a bad_request result', async () => {
    processRetellWebhook.mockResolvedValue({ status: 'bad_request', reason: 'bad json' });
    expect((await post()).status).toBe(400);
  });

  it('returns 500 (so Retell retries) when the service throws, e.g. a DB failure', async () => {
    processRetellWebhook.mockRejectedValue(new Error('db down'));
    const res = await post();
    expect(res.status).toBe(500);
    // The central error handler must not leak the internal message.
    expect(JSON.stringify(res.body)).not.toContain('db down');
  });

  it('does not expose the signature value in the response', async () => {
    processRetellWebhook.mockResolvedValue({ status: 'unauthorized', reason: 'invalid signature' });
    const res = await post();
    expect(JSON.stringify(res.body)).not.toContain('deadbeef');
  });
});
