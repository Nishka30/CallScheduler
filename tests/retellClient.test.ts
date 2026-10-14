import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetellClient } from '../src/integrations/retell/client.js';
import type { RetellApiError } from '../src/integrations/retell/errors.js';
import { parseEnv } from '../src/config/env.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const TEST_KEY = 'retell-test-key-never-real';
const FROM = '+19789538571';
const AGENT = 'agent_travel_call_test';
const TO = '+447700900123';

/**
 * Builds a config with calling ENABLED. This only fabricates an isolated config
 * object passed to the client; it never mutates `process.env` or the global
 * `env`, so the real master switch (`RETELL_CALLING_ENABLED=false`) is untouched.
 */
function config(overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    RETELL_CALLING_ENABLED: 'true',
    RETELL_API_KEY: TEST_KEY,
    RETELL_FROM_NUMBER: FROM,
    RETELL_AGENT_ID: AGENT,
    RETELL_AGENT_NAME: 'Travel Call Agent',
    ...overrides,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function stubFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: href, init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected extra fetch call');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, overrides: Record<string, string> = {}) {
  return new RetellClient({ fetchImpl }, config(overrides));
}

const OK = { call_id: 'call_abc123', agent_id: AGENT, call_status: 'registered' };

async function rejection(promise: Promise<unknown>): Promise<RetellApiError> {
  try {
    await promise;
  } catch (error) {
    return error as RetellApiError;
  }
  throw new Error('expected the call to reject');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('1. calling disabled', () => {
  it('refuses and makes no HTTP request when the master switch is off', async () => {
    const { impl, calls } = stubFetch(jsonResponse(OK));
    const c = client(impl, { RETELL_CALLING_ENABLED: 'false' });

    const error = await rejection(c.createPhoneCall({ toNumber: TO }));

    expect(error.kind).toBe('disabled');
    expect(error.preflight).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('is disabled by default (no override) - a default config never calls', async () => {
    const { impl, calls } = stubFetch(jsonResponse(OK));
    // Default parseEnv: RETELL_CALLING_ENABLED defaults to false.
    const c = new RetellClient(
      { fetchImpl: impl },
      parseEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        RETELL_API_KEY: TEST_KEY,
        RETELL_FROM_NUMBER: FROM,
        RETELL_AGENT_ID: AGENT,
      }),
    );

    await expect(c.createPhoneCall({ toNumber: TO })).rejects.toMatchObject({ kind: 'disabled' });
    expect(calls).toHaveLength(0);
  });
});

describe('2. missing configuration', () => {
  it('fails with kind "config" and no request when the API key is missing', async () => {
    const { impl, calls } = stubFetch(jsonResponse(OK));
    const error = await rejection(
      client(impl, { RETELL_API_KEY: '' }).createPhoneCall({ toNumber: TO }),
    );

    expect(error.kind).toBe('config');
    expect(error.message).toContain('RETELL_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('fails when the from-number is missing', async () => {
    const { impl } = stubFetch(jsonResponse(OK));
    const error = await rejection(
      client(impl, { RETELL_FROM_NUMBER: '' }).createPhoneCall({ toNumber: TO }),
    );

    expect(error.kind).toBe('config');
    expect(error.message).toContain('RETELL_FROM_NUMBER');
  });

  it('fails when the from-number is not E.164', async () => {
    const { impl, calls } = stubFetch(jsonResponse(OK));
    const error = await rejection(
      client(impl, { RETELL_FROM_NUMBER: '1978-bad' }).createPhoneCall({ toNumber: TO }),
    );

    expect(error.kind).toBe('config');
    expect(calls).toHaveLength(0);
  });
});

describe('3. missing agent configuration', () => {
  it('fails with kind "config" when the agent id is missing', async () => {
    const { impl, calls } = stubFetch(jsonResponse(OK));
    const error = await rejection(
      client(impl, { RETELL_AGENT_ID: '' }).createPhoneCall({ toNumber: TO }),
    );

    expect(error.kind).toBe('config');
    expect(error.message).toContain('RETELL_AGENT_ID');
    expect(calls).toHaveLength(0);
  });
});

describe('4. invalid destination number', () => {
  it.each(['not-a-number', '07700900123', '+0123', '', '  '])(
    'rejects %j before contacting Retell',
    async (bad) => {
      const { impl, calls } = stubFetch(jsonResponse(OK));
      const error = await rejection(client(impl).createPhoneCall({ toNumber: bad }));

      expect(error.kind).toBe('invalid_destination');
      expect(calls).toHaveLength(0);
    },
  );
});

describe('5. successful call', () => {
  it('returns the provider call id and safe fields', async () => {
    const { impl } = stubFetch(jsonResponse(OK));

    const result = await client(impl).createPhoneCall({ toNumber: TO });

    expect(result).toEqual({
      callId: 'call_abc123',
      agentId: AGENT,
      callStatus: 'registered',
    });
  });

  it('POSTs to the verified endpoint with a bearer header and the documented body', async () => {
    const { impl, calls } = stubFetch(jsonResponse(OK));

    await client(impl).createPhoneCall({
      toNumber: TO,
      idempotencyKey: 'call-record-1',
      metadata: { leadId: 'lead-1', callRecordId: 'call-record-1' },
    });

    const call = calls[0]!;
    expect(call.url).toBe('https://api.retellai.com/v2/create-phone-call');
    expect(call.init.method).toBe('POST');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TEST_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(call.init.body as string);
    expect(body).toMatchObject({
      from_number: FROM,
      to_number: TO,
      override_agent_id: AGENT,
      idempotency_key: 'call-record-1',
      metadata: { leadId: 'lead-1', callRecordId: 'call-record-1' },
    });
  });

  it('omits dynamic variables unless explicitly supplied', async () => {
    const { impl, calls } = stubFetch(jsonResponse(OK));

    await client(impl).createPhoneCall({ toNumber: TO });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).not.toHaveProperty('retell_llm_dynamic_variables');
  });

  it('passes dynamic variables through verbatim when supplied', async () => {
    const { impl, calls } = stubFetch(jsonResponse(OK));

    await client(impl).createPhoneCall({
      toNumber: TO,
      dynamicVariables: { customer_name: 'Alex' },
    });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.retell_llm_dynamic_variables).toEqual({ customer_name: 'Alex' });
  });
});

describe('6. authentication and HTTP errors', () => {
  it('maps 401 to kind "auth" and does not treat it as uncertain', async () => {
    const { impl } = stubFetch(jsonResponse({ error_message: 'bad key' }, { status: 401 }));
    const error = await rejection(client(impl).createPhoneCall({ toNumber: TO }));

    expect(error.kind).toBe('auth');
    expect(error.uncertain).toBe(false);
  });

  it('maps a 400 to kind "client"', async () => {
    const { impl } = stubFetch(jsonResponse({ error_message: 'bad request' }, { status: 400 }));
    await expect(client(impl).createPhoneCall({ toNumber: TO })).rejects.toMatchObject({
      kind: 'client',
    });
  });

  it('maps 429 to kind "rate_limited"', async () => {
    const { impl } = stubFetch(jsonResponse({}, { status: 429 }));
    await expect(client(impl).createPhoneCall({ toNumber: TO })).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });
});

describe('7. timeout and network failure (uncertain)', () => {
  it('maps a timeout to kind "network" and marks it uncertain', async () => {
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';
    const { impl } = stubFetch(timeout);

    const error = await rejection(client(impl).createPhoneCall({ toNumber: TO }));

    expect(error.kind).toBe('network');
    expect(error.uncertain).toBe(true);
    expect(error.message).toMatch(/reconciled/);
  });

  it('maps a socket failure to kind "network" (uncertain)', async () => {
    const { impl } = stubFetch(new TypeError('fetch failed'));

    const error = await rejection(client(impl).createPhoneCall({ toNumber: TO }));

    expect(error.kind).toBe('network');
    expect(error.uncertain).toBe(true);
  });

  it('treats a 5xx as uncertain too (the call may have been accepted)', async () => {
    const { impl } = stubFetch(jsonResponse({}, { status: 502 }));

    const error = await rejection(client(impl).createPhoneCall({ toNumber: TO }));

    expect(error.kind).toBe('server');
    expect(error.uncertain).toBe(true);
  });

  it('never retries - exactly one request is attempted even on a 5xx', async () => {
    const { impl, calls } = stubFetch(jsonResponse({}, { status: 503 }));

    await rejection(client(impl).createPhoneCall({ toNumber: TO }));

    expect(calls).toHaveLength(1);
  });
});

describe('8. malformed responses and missing call id', () => {
  it('rejects a 2xx body that is not valid JSON', async () => {
    const { impl } = stubFetch(
      new Response('{not json', { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    await expect(client(impl).createPhoneCall({ toNumber: TO })).rejects.toMatchObject({
      kind: 'contract',
    });
  });

  it('rejects a 2xx response that has no call_id (never a silent success)', async () => {
    const { impl } = stubFetch(jsonResponse({ agent_id: AGENT, call_status: 'registered' }));
    const error = await rejection(client(impl).createPhoneCall({ toNumber: TO }));

    expect(error.kind).toBe('contract');
    expect(error.message).toMatch(/call_id/);
  });

  it('rejects an empty call_id', async () => {
    const { impl } = stubFetch(jsonResponse({ call_id: '' }));
    await expect(client(impl).createPhoneCall({ toNumber: TO })).rejects.toMatchObject({
      kind: 'contract',
    });
  });
});

describe('9. idempotency / duplicate-call protection at the provider', () => {
  it('forwards the idempotency key so a duplicate submit cannot double-dial', async () => {
    const { impl, calls } = stubFetch(jsonResponse(OK));

    await client(impl).createPhoneCall({ toNumber: TO, idempotencyKey: 'attempt-42' });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.idempotency_key).toBe('attempt-42');
  });
});

describe('11. no secret or PII leakage', () => {
  it('never puts the bearer key or destination number into a thrown error', async () => {
    const { impl } = stubFetch(jsonResponse({ error_message: 'nope' }, { status: 401 }));

    const error = await rejection(client(impl).createPhoneCall({ toNumber: TO }));
    const serialized = JSON.stringify({ message: error.message, path: error.path });

    expect(serialized).not.toContain(TEST_KEY);
    expect(serialized).not.toContain(TO);
  });

  it('keeps the key only in the Authorization header, never elsewhere in the request', async () => {
    const { impl, calls } = stubFetch(jsonResponse(OK));

    await client(impl).createPhoneCall({ toNumber: TO });

    const { url, init } = calls[0]!;
    expect(url).not.toContain(TEST_KEY);
    expect(init.body as string).not.toContain(TEST_KEY);
  });
});
