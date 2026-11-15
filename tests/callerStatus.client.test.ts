import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { CallerStatusClient } from '../src/integrations/guidedBoost/callerStatus.client.js';

/** Builds a minimal fetch Response stand-in. */
function response(status: number, body: unknown = { ok: true }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function config() {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    LEAD_API_KEY_CALLER: 'secret-key',
    CRM_AGENT_EMAIL: 'ai-caller@himalayanwonders.com',
    CALLER_QUEUE_BASE_URL: 'https://guided-boost.lovable.app',
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
});

describe('CallerStatusClient.reportFinalStatus', () => {
  it('posts to the lead status endpoint with the caller auth identity and a valid body', async () => {
    fetchMock.mockResolvedValue(response(200));
    const client = new CallerStatusClient({ fetchImpl: fetchMock as unknown as typeof fetch }, config());

    const result = await client.reportFinalStatus('lead-1', { status: 'no_answer', reason: 'busy' });

    expect(result.outcome).toBe('sent');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://guided-boost.lovable.app/api/caller/leads/lead-1/status');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Lead-API-Key']).toBe('secret-key');
    expect(init.headers['X-Agent-Email']).toBe('ai-caller@himalayanwonders.com');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'no_answer', reason: 'busy' });
  });

  it('treats 409 as a conflict (a different final already won; do not override)', async () => {
    fetchMock.mockResolvedValue(response(409, { error: 'already finalized' }));
    const client = new CallerStatusClient({ fetchImpl: fetchMock as unknown as typeof fetch }, config());

    const result = await client.reportFinalStatus('lead-1', { status: 'booked' });

    expect(result).toMatchObject({ outcome: 'conflict', httpStatus: 409 });
  });

  it('treats a 5xx as a retryable failure', async () => {
    fetchMock.mockResolvedValue(response(503));
    const client = new CallerStatusClient({ fetchImpl: fetchMock as unknown as typeof fetch }, config());

    const result = await client.reportFinalStatus('lead-1', { status: 'booked' });

    expect(result).toMatchObject({ outcome: 'failed', httpStatus: 503, errorKind: 'server' });
  });

  it('treats a network error as a retryable failure (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    const client = new CallerStatusClient({ fetchImpl: fetchMock as unknown as typeof fetch }, config());

    const result = await client.reportFinalStatus('lead-1', { status: 'voicemail' });

    expect(result).toMatchObject({ outcome: 'failed', errorKind: 'network' });
  });

  it('accepts every confirmed final status and rejects an unsupported one', async () => {
    fetchMock.mockResolvedValue(response(200));
    const client = new CallerStatusClient({ fetchImpl: fetchMock as unknown as typeof fetch }, config());

    for (const status of [
      'booked',
      'reached_no_booking',
      'callback_requested',
      'no_answer',
      'voicemail',
      'wrong_number',
      'do_not_call',
      'call_failed',
      'not_attempted',
    ] as const) {
      expect((await client.reportFinalStatus('lead-1', { status })).outcome).toBe('sent');
    }

    // call_in_progress is NOT a final status; it is rejected by the final-status body.
    await expect(
      client.reportFinalStatus('lead-1', { status: 'call_in_progress' } as never),
    ).rejects.toThrow();
  });
});

describe('CallerStatusClient.reportCallInProgress', () => {
  it('posts { status: call_in_progress } with the caller auth identity', async () => {
    fetchMock.mockResolvedValue(response(200, { ok: true, extended: false, call_before: '2026-11-15T09:10:00.000Z' }));
    const client = new CallerStatusClient({ fetchImpl: fetchMock as unknown as typeof fetch }, config());

    await client.reportCallInProgress('lead-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://guided-boost.lovable.app/api/caller/leads/lead-1/status');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Lead-API-Key']).toBe('secret-key');
    expect(init.headers['X-Agent-Email']).toBe('ai-caller@himalayanwonders.com');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'call_in_progress' });
  });

  it('extension granted → outcome "extended" with the NEW call_before parsed', async () => {
    fetchMock.mockResolvedValue(response(200, { ok: true, extended: true, call_before: '2026-11-15T09:20:00.000Z' }));
    const client = new CallerStatusClient({ fetchImpl: fetchMock as unknown as typeof fetch }, config());

    const result = await client.reportCallInProgress('lead-1');

    expect(result.outcome).toBe('extended');
    expect(result.callBefore?.toISOString()).toBe('2026-11-15T09:20:00.000Z');
  });

  it('no extension → outcome "not_extended" preserving the returned deadline', async () => {
    fetchMock.mockResolvedValue(response(200, { ok: true, extended: false, call_before: '2026-11-15T09:10:00.000Z' }));
    const client = new CallerStatusClient({ fetchImpl: fetchMock as unknown as typeof fetch }, config());

    const result = await client.reportCallInProgress('lead-1');

    expect(result.outcome).toBe('not_extended');
    expect(result.callBefore?.toISOString()).toBe('2026-11-15T09:10:00.000Z');
  });

  it('409 → conflict (resolved; do not retry)', async () => {
    fetchMock.mockResolvedValue(response(409, { error: 'finalized' }));
    const client = new CallerStatusClient({ fetchImpl: fetchMock as unknown as typeof fetch }, config());
    expect((await client.reportCallInProgress('lead-1')).outcome).toBe('conflict');
  });

  it('5xx / network → failed (recoverable), never throws', async () => {
    fetchMock.mockResolvedValue(response(503));
    const client = new CallerStatusClient({ fetchImpl: fetchMock as unknown as typeof fetch }, config());
    expect((await client.reportCallInProgress('lead-1')).outcome).toBe('failed');

    fetchMock.mockRejectedValue(new Error('socket hang up'));
    expect((await client.reportCallInProgress('lead-1')).outcome).toBe('failed');
  });
});
