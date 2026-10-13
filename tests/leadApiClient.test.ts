import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadApiClient } from '../src/integrations/leadApi/client.js';
import { LeadApiError } from '../src/integrations/leadApi/errors.js';
import { parseEnv } from '../src/config/env.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const TEST_KEY = 'test-key-never-real';

function config(overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    LEAD_API_KEY_CALLER: TEST_KEY,
    LEAD_API_MAX_RETRIES: '2',
    ...overrides,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Captures calls so tests can assert on URL and headers. */
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

function makeClient(fetchImpl: typeof fetch, overrides: Record<string, string> = {}) {
  return new LeadApiClient({ fetchImpl, sleep: () => Promise.resolve() }, config(overrides));
}

/** Awaits a rejection and returns it as the expected error type. */
async function rejection(promise: Promise<unknown>): Promise<LeadApiError> {
  try {
    await promise;
  } catch (error) {
    return error as LeadApiError;
  }
  throw new Error('expected the request to reject');
}

const PAGE = { leads: [{ id: '1', updated_at: '2026-10-01T00:00:00.000Z' }], nextCursor: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authentication', () => {
  it('sends the API key in the X-Lead-API-Key header on every request', async () => {
    const { impl, calls } = stubFetch(jsonResponse(PAGE));

    await makeClient(impl).listLeads();

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Lead-API-Key']).toBe(TEST_KEY);
  });

  it('sends no Authorization header and no cookies', async () => {
    const { impl, calls } = stubFetch(jsonResponse(PAGE));

    await makeClient(impl).listLeads();

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Cookie']).toBeUndefined();
  });

  it('fails clearly when the key is missing, without revealing any value', () => {
    const envWithoutKey = parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });

    expect(() => new LeadApiClient({}, envWithoutKey)).toThrow(
      /LEAD_API_KEY_CALLER is not configured/,
    );
  });

  it('never puts the key into a thrown error', async () => {
    const { impl } = stubFetch(jsonResponse({ error: 'Unauthorized' }, { status: 401 }));

    const error = await rejection(makeClient(impl).listLeads());

    expect(JSON.stringify({ message: error.message, path: error.path })).not.toContain(TEST_KEY);
  });

  it('does not retry a 401', async () => {
    const { impl, calls } = stubFetch(jsonResponse({ error: 'bad key' }, { status: 401 }));

    await expect(makeClient(impl).listLeads()).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toHaveLength(1);
  });

  it('does not retry a 403 (read-only key used for a forbidden operation)', async () => {
    const { impl, calls } = stubFetch(jsonResponse({ error: 'forbidden' }, { status: 403 }));

    await expect(makeClient(impl).listLeads()).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toHaveLength(1);
  });
});

describe('read-only guarantee', () => {
  it('only ever issues GET requests', async () => {
    const { impl, calls } = stubFetch(
      jsonResponse(PAGE),
      jsonResponse({ captured: {}, current: {} }),
      jsonResponse({ profile: {} }),
    );
    const client = makeClient(impl);

    await client.listLeads();
    await client.getLead('1');
    await client.getPerson('lead:1');

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init.method).toBe('GET');
      expect(call.init.body).toBeUndefined();
    }
  });
});

describe('URL construction', () => {
  it('URL-encodes a person key containing a colon and an email address', async () => {
    const { impl, calls } = stubFetch(jsonResponse({ profile: {} }));

    await makeClient(impl).getPerson('email:someone+tag@example.com');

    expect(calls[0]!.url).toContain('/api/crm/persons/email%3Asomeone%2Btag%40example.com');
    expect(calls[0]!.url).not.toContain('someone+tag@example.com');
  });

  it('URL-encodes a lead id with path-significant characters', async () => {
    const { impl, calls } = stubFetch(jsonResponse({ captured: {} }));

    await makeClient(impl).getLead('a/b?c');

    expect(calls[0]!.url).toContain('/api/crm/leads/a%2Fb%3Fc');
  });

  it('sends since, cursor, brand and limit as separate query parameters', async () => {
    const { impl, calls } = stubFetch(jsonResponse(PAGE));

    await makeClient(impl).listLeads({
      since: '2026-10-01T00:00:00.000Z',
      cursor: '2026-10-02T00:00:00.000Z',
      brand: 'HW',
      limit: 200,
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/crm/leads');
    expect(url.searchParams.get('since')).toBe('2026-10-01T00:00:00.000Z');
    expect(url.searchParams.get('cursor')).toBe('2026-10-02T00:00:00.000Z');
    expect(url.searchParams.get('brand')).toBe('HW');
    expect(url.searchParams.get('limit')).toBe('200');
  });

  it('omits parameters that were not supplied', async () => {
    const { impl, calls } = stubFetch(jsonResponse(PAGE));

    await makeClient(impl).listLeads({ limit: 50 });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.has('since')).toBe(false);
    expect(url.searchParams.has('cursor')).toBe(false);
  });
});

describe('response contract handling', () => {
  it('parses a documented page and returns nextCursor verbatim', async () => {
    const { impl } = stubFetch(
      jsonResponse({
        leads: [{ id: 7, updated_at: '2026-10-01T00:00:00.000Z', person_key: 'lead:7' }],
        nextCursor: '2026-10-01T00:00:00.000Z',
      }),
    );

    const page = await makeClient(impl).listLeads();

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe('7');
    expect(page.nextCursor).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rejects a malformed JSON body instead of treating it as an empty page', async () => {
    const { impl } = stubFetch(
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const error = await rejection(makeClient(impl).listLeads());

    expect(error.kind).toBe('contract');
    expect(error).toBeInstanceOf(LeadApiError);
  });

  it('rejects an ambiguous page shape rather than guessing the rows key', async () => {
    const { impl } = stubFetch(jsonResponse({ leads: [], extras: [], nextCursor: null }));

    await expect(makeClient(impl).listLeads()).rejects.toMatchObject({ kind: 'contract' });
  });

  it('rejects a response containing no array of rows', async () => {
    const { impl } = stubFetch(jsonResponse({ nextCursor: null }));

    await expect(makeClient(impl).listLeads()).rejects.toMatchObject({ kind: 'contract' });
  });

  it('rejects a row missing the documented updated_at cursor field', async () => {
    const { impl } = stubFetch(jsonResponse({ leads: [{ id: '1' }], nextCursor: null }));

    await expect(makeClient(impl).listLeads()).rejects.toMatchObject({ kind: 'contract' });
  });

  it('reports a missing nextCursor key without inventing one', async () => {
    const { impl } = stubFetch(
      jsonResponse({ leads: [{ id: '1', updated_at: '2026-10-01T00:00:00.000Z' }] }),
    );

    const page = await makeClient(impl).listLeads();

    expect(page.nextCursorAbsent).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it('does not retry a contract violation', async () => {
    const { impl, calls } = stubFetch(jsonResponse({ nextCursor: null }));

    await expect(makeClient(impl).listLeads()).rejects.toMatchObject({ kind: 'contract' });
    expect(calls).toHaveLength(1);
  });
});

describe('retry behaviour', () => {
  it('retries a 429 and succeeds', async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({ error: 'slow down' }, { status: 429 }),
      jsonResponse(PAGE),
    );

    const page = await makeClient(impl).listLeads();

    expect(calls).toHaveLength(2);
    expect(page.rows).toHaveLength(1);
  });

  it('retries a 500 and succeeds', async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({ error: 'boom' }, { status: 500 }),
      jsonResponse(PAGE),
    );

    await makeClient(impl).listLeads();

    expect(calls).toHaveLength(2);
  });

  it('retries a network failure and succeeds', async () => {
    const { impl, calls } = stubFetch(new TypeError('fetch failed'), jsonResponse(PAGE));

    await makeClient(impl).listLeads();

    expect(calls).toHaveLength(2);
  });

  it('classifies a timeout as a network failure', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const { impl } = stubFetch(timeout, timeout, timeout);

    const error = await rejection(makeClient(impl).listLeads());

    expect(error.kind).toBe('network');
    expect(error.message).toMatch(/timed out/);
  });

  it('gives up after the configured retry budget', async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({ error: 'boom' }, { status: 503 }),
      jsonResponse({ error: 'boom' }, { status: 503 }),
      jsonResponse({ error: 'boom' }, { status: 503 }),
    );

    await expect(makeClient(impl).listLeads()).rejects.toMatchObject({ kind: 'server' });
    // 1 initial attempt + LEAD_API_MAX_RETRIES (2)
    expect(calls).toHaveLength(3);
  });

  it('never retries a 404', async () => {
    const { impl, calls } = stubFetch(jsonResponse({ error: 'not found' }, { status: 404 }));

    await expect(makeClient(impl).getLead('missing')).rejects.toMatchObject({ kind: 'not_found' });
    expect(calls).toHaveLength(1);
  });

  it('honours a numeric Retry-After header', async () => {
    const sleeps: number[] = [];
    const { impl } = stubFetch(
      new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
      jsonResponse(PAGE),
    );
    const client = new LeadApiClient(
      {
        fetchImpl: impl,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
      config(),
    );

    await client.listLeads();

    expect(sleeps).toEqual([2000]);
  });

  it('can be configured with no retries at all', async () => {
    const { impl, calls } = stubFetch(jsonResponse({ error: 'boom' }, { status: 500 }));

    await expect(makeClient(impl, { LEAD_API_MAX_RETRIES: '0' }).listLeads()).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
