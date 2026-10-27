import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallOutcome, CallStatus } from '@prisma/client';
import { verifyRetellSignature } from '../src/integrations/retell/webhookVerify.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

// Mock only the persistence boundary; verify, schema and map run for real.
const applyWebhookCallEvent = vi.fn();
vi.mock('../src/repositories/callRecord.repository.js', () => ({
  applyWebhookCallEvent: (...args: unknown[]) => applyWebhookCallEvent(...args),
}));

const completeCallingLead = vi.fn();
vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  completeCallingLead: (...args: unknown[]) => completeCallingLead(...args),
}));

const { processRetellWebhook } = await import('../src/services/retellWebhook.service.js');

const KEY = 'retell-test-key-never-real';
const NOW = 1_760_000_000_000; // fixed clock

/** Produces a valid Retell signature for `body` at `ts`, matching the SDK format. */
function sign(body: string, key: string, ts: number): string {
  const digest = createHmac('sha256', key)
    .update(body + String(ts))
    .digest('hex');
  return `v=${ts},d=${digest}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  completeCallingLead.mockResolvedValue(true);
});

describe('verifyRetellSignature', () => {
  const body = '{"event":"call_ended","call":{"call_id":"call_1"}}';

  it('accepts a correct signature within the replay window', () => {
    expect(verifyRetellSignature(body, KEY, sign(body, KEY, NOW), { now: NOW })).toBe(true);
  });

  it('rejects a signature made with a different key', () => {
    expect(verifyRetellSignature(body, KEY, sign(body, 'other-key', NOW), { now: NOW })).toBe(
      false,
    );
  });

  it('rejects when the body was tampered with after signing', () => {
    const sig = sign(body, KEY, NOW);
    expect(verifyRetellSignature(body + ' ', KEY, sig, { now: NOW })).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(verifyRetellSignature(body, KEY, 'not-a-signature', { now: NOW })).toBe(false);
    expect(verifyRetellSignature(body, KEY, 'v=abc,d=xyz', { now: NOW })).toBe(false);
  });

  it('rejects a stale timestamp outside the 5-minute replay window', () => {
    const old = NOW - 6 * 60 * 1000;
    expect(verifyRetellSignature(body, KEY, sign(body, KEY, old), { now: NOW })).toBe(false);
  });

  it('accepts a timestamp just inside the window and rejects just outside', () => {
    const inside = NOW - 4 * 60 * 1000;
    const outside = NOW - 5 * 60 * 1000 - 1;
    expect(verifyRetellSignature(body, KEY, sign(body, KEY, inside), { now: NOW })).toBe(true);
    expect(verifyRetellSignature(body, KEY, sign(body, KEY, outside), { now: NOW })).toBe(false);
  });

  it('rejects a digest of the wrong length', () => {
    expect(verifyRetellSignature(body, KEY, `v=${NOW},d=abcd`, { now: NOW })).toBe(false);
  });

  it('rejects an empty key or empty signature', () => {
    expect(verifyRetellSignature(body, '', sign(body, KEY, NOW), { now: NOW })).toBe(false);
    expect(verifyRetellSignature(body, KEY, '', { now: NOW })).toBe(false);
  });
});

describe('processRetellWebhook', () => {
  function call(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      event: 'call_ended',
      call: { call_id: 'call_1', call_status: 'ended', ...overrides },
    });
  }

  function run(body: string, opts: { key?: string; signature?: string } = {}) {
    const key = opts.key ?? KEY;
    const signature = opts.signature ?? sign(body, key, NOW);
    return processRetellWebhook({ rawBody: body, signature, apiKey: key, now: NOW });
  }

  it('fails closed (misconfigured) when the verification secret is missing', async () => {
    const body = call();
    const result = await processRetellWebhook({
      rawBody: body,
      signature: sign(body, KEY, NOW),
      apiKey: undefined,
      now: NOW,
    });
    expect(result.status).toBe('misconfigured');
    expect(applyWebhookCallEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing signature as unauthorized', async () => {
    const body = call();
    const result = await processRetellWebhook({
      rawBody: body,
      signature: undefined,
      apiKey: KEY,
      now: NOW,
    });
    expect(result.status).toBe('unauthorized');
    expect(applyWebhookCallEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature as unauthorized', async () => {
    const body = call();
    const result = await run(body, { signature: sign(body, 'wrong-key', NOW) });
    expect(result.status).toBe('unauthorized');
    expect(applyWebhookCallEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON (even with a valid signature) as bad_request', async () => {
    const body = '{not json';
    const result = await run(body);
    expect(result.status).toBe('bad_request');
  });

  it('rejects a payload missing call.call_id as bad_request', async () => {
    const body = JSON.stringify({ event: 'call_ended', call: { call_status: 'ended' } });
    const result = await run(body);
    expect(result.status).toBe('bad_request');
  });

  it('acknowledges an unsupported event without processing it', async () => {
    const body = JSON.stringify({ event: 'transcript_updated', call: { call_id: 'call_1' } });
    const result = await run(body);
    expect(result).toMatchObject({ status: 'ignored', event: 'transcript_updated' });
    expect(applyWebhookCallEvent).not.toHaveBeenCalled();
  });

  it('reports unmatched for an unknown call id, never fabricating a record', async () => {
    applyWebhookCallEvent.mockResolvedValue({ matched: false, changed: false });
    const result = await run(call());
    expect(result).toMatchObject({ status: 'unmatched', callId: 'call_1' });
  });

  it('processes a supported event and persists the mapped result', async () => {
    applyWebhookCallEvent.mockResolvedValue({ matched: true, changed: true });
    const body = call({ disconnection_reason: 'voicemail_reached' });

    const result = await run(body);

    expect(result).toMatchObject({ status: 'processed', event: 'call_ended', changed: true });
    const [callId, update] = applyWebhookCallEvent.mock.calls[0]!;
    expect(callId).toBe('call_1');
    expect(update).toMatchObject({ status: CallStatus.COMPLETED, outcome: CallOutcome.VOICEMAIL });
  });

  it('passes start/end timestamps and summary into the update', async () => {
    applyWebhookCallEvent.mockResolvedValue({ matched: true, changed: true });
    const body = JSON.stringify({
      event: 'call_analyzed',
      call: {
        call_id: 'call_1',
        call_status: 'ended',
        start_timestamp: 1_760_000_000_000,
        end_timestamp: 1_760_000_060_000,
        call_analysis: { call_summary: 'Spoke with the customer about a trek.' },
      },
    });

    await run(body);

    const [, update] = applyWebhookCallEvent.mock.calls[0]!;
    expect(update.summary).toContain('trek');
    expect(update.startedAt).toBeInstanceOf(Date);
    expect(update.endedAt).toBeInstanceOf(Date);
  });

  it('lets a database error propagate (so the controller returns 5xx and Retell retries)', async () => {
    applyWebhookCallEvent.mockRejectedValue(new Error('db down'));
    await expect(run(call())).rejects.toThrow('db down');
  });

  it('never includes the verification secret in its result', async () => {
    applyWebhookCallEvent.mockResolvedValue({ matched: true, changed: true });
    const result = await run(call());
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe('processRetellWebhook — terminal lead-processing transition', () => {
  function call(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      event: 'call_ended',
      call: { call_id: 'call_1', call_status: 'ended', ...overrides },
    });
  }
  function run(body: string) {
    return processRetellWebhook({
      rawBody: body,
      signature: sign(body, KEY, NOW),
      apiKey: KEY,
      now: NOW,
    });
  }
  const terminal = (status: CallStatus) => ({
    matched: true,
    changed: true,
    record: { leadId: 'lead-1', status },
  });

  it('completes the lead (CALLING→COMPLETED) when the call reaches a terminal state', async () => {
    applyWebhookCallEvent.mockResolvedValue(terminal(CallStatus.COMPLETED));

    const result = await run(call());

    expect(result.status).toBe('processed');
    expect(completeCallingLead).toHaveBeenCalledWith('lead-1');
  });

  it('handles a duplicate/late terminal event as a safe no-op (lead already finished)', async () => {
    applyWebhookCallEvent.mockResolvedValue(terminal(CallStatus.COMPLETED));
    completeCallingLead.mockResolvedValue(false); // status guard matched nothing

    const result = await run(call());

    expect(result.status).toBe('processed'); // still acknowledged, no error
    expect(completeCallingLead).toHaveBeenCalledTimes(1);
  });

  it('transitions for every terminal call status (no_answer / busy / failed / canceled)', async () => {
    for (const status of [
      CallStatus.NO_ANSWER,
      CallStatus.BUSY,
      CallStatus.FAILED,
      CallStatus.CANCELED,
    ]) {
      completeCallingLead.mockClear();
      applyWebhookCallEvent.mockResolvedValue(terminal(status));
      await run(call());
      expect(completeCallingLead).toHaveBeenCalledWith('lead-1');
    }
  });

  it('does NOT transition the lead for a non-terminal call status', async () => {
    applyWebhookCallEvent.mockResolvedValue({
      matched: true,
      changed: true,
      record: { leadId: 'lead-1', status: CallStatus.IN_PROGRESS },
    });

    const body = JSON.stringify({
      event: 'call_started',
      call: { call_id: 'call_1', call_status: 'ongoing' },
    });
    const result = await run(body);

    expect(result.status).toBe('processed');
    expect(completeCallingLead).not.toHaveBeenCalled();
  });

  it('does NOT transition the lead for an unmatched call id', async () => {
    applyWebhookCallEvent.mockResolvedValue({ matched: false, changed: false });

    const result = await run(call());

    expect(result.status).toBe('unmatched');
    expect(completeCallingLead).not.toHaveBeenCalled();
  });

  it('acknowledges the webhook even if the lead transition fails (logged, never thrown)', async () => {
    applyWebhookCallEvent.mockResolvedValue(terminal(CallStatus.COMPLETED));
    completeCallingLead.mockRejectedValue(new Error('db blip'));

    // The call record is already updated; a lead-transition failure must not force
    // Retell to retry (the next event / a reaper reconciles it).
    const result = await run(call());

    expect(result.status).toBe('processed');
    expect(completeCallingLead).toHaveBeenCalledWith('lead-1');
  });
});
