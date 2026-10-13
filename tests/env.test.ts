import { describe, expect, it } from 'vitest';
import { parseEnv, requireLeadApiKey } from '../src/config/env.js';

const VALID_DB_URL = 'postgresql://user:pass@localhost:5432/db?schema=public';

function base(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { DATABASE_URL: VALID_DB_URL, ...overrides };
}

describe('environment validation', () => {
  it('applies documented defaults when optional variables are absent', () => {
    const env = parseEnv(base());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('coerces PORT to a number', () => {
    expect(parseEnv(base({ PORT: '8080' })).PORT).toBe(8080);
  });

  it('fails when DATABASE_URL is missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('fails when DATABASE_URL is not a PostgreSQL URL', () => {
    expect(() => parseEnv(base({ DATABASE_URL: 'mysql://user:pass@localhost/db' }))).toThrow(
      /PostgreSQL connection string/,
    );
  });

  it('never echoes the offending value in the error message', () => {
    const secret = 'mysql://admin:sup3rs3cret@db.internal/prod';
    let message = '';

    try {
      parseEnv(base({ DATABASE_URL: secret }));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('sup3rs3cret');
    expect(message).not.toContain('db.internal');
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => parseEnv(base({ NODE_ENV: 'staging' }))).toThrow(/NODE_ENV/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => parseEnv(base({ PORT: '70000' }))).toThrow(/PORT/);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => parseEnv(base({ PORT: 'abc' }))).toThrow(/PORT/);
  });

  it('parses a CORS allowlist into trimmed origins', () => {
    const env = parseEnv(base({ CORS_ALLOWED_ORIGINS: 'https://a.example , https://b.example' }));

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects a wildcard CORS origin', () => {
    expect(() => parseEnv(base({ CORS_ALLOWED_ORIGINS: '*' }))).toThrow(/must not contain/);
  });

  it('reports every invalid variable at once', () => {
    const run = (): unknown => parseEnv({ NODE_ENV: 'nope', PORT: '-1' });

    expect(run).toThrow(/NODE_ENV/);
    expect(run).toThrow(/PORT/);
    expect(run).toThrow(/DATABASE_URL/);
  });
});

describe('Lead API configuration', () => {
  it('defaults to the documented base URL', () => {
    expect(parseEnv(base()).LEAD_API_BASE_URL).toBe('https://guided-boost.lovable.app');
  });

  it('normalises away a trailing slash on the base URL', () => {
    expect(parseEnv(base({ LEAD_API_BASE_URL: 'https://example.com/' })).LEAD_API_BASE_URL).toBe(
      'https://example.com',
    );
  });

  it('rejects a plaintext base URL so the key is never sent in clear', () => {
    expect(() => parseEnv(base({ LEAD_API_BASE_URL: 'http://example.com' }))).toThrow(/https/);
  });

  it('rejects a base URL that is not a URL', () => {
    expect(() => parseEnv(base({ LEAD_API_BASE_URL: 'not a url' }))).toThrow(/LEAD_API_BASE_URL/);
  });

  it('treats the API key as optional so the server boots without it', () => {
    expect(parseEnv(base()).LEAD_API_KEY_CALLER).toBeUndefined();
  });

  it('treats an EMPTY key placeholder as absent, not as invalid', () => {
    // `.env.example` ships `LEAD_API_KEY_CALLER=`, which dotenv loads as ''.
    // That must not stop the server booting.
    expect(parseEnv(base({ LEAD_API_KEY_CALLER: '' })).LEAD_API_KEY_CALLER).toBeUndefined();
    expect(parseEnv(base({ LEAD_API_KEY_CALLER: '   ' })).LEAD_API_KEY_CALLER).toBeUndefined();
  });

  it('treats other empty optional placeholders as absent', () => {
    const env = parseEnv(base({ LEAD_API_BRAND: '', LEAD_POLL_INITIAL_SINCE: '' }));

    expect(env.LEAD_API_BRAND).toBeUndefined();
    expect(env.LEAD_POLL_INITIAL_SINCE).toBeUndefined();
  });

  it('throws a value-free error when the key is required but missing', () => {
    const env = parseEnv(base());

    expect(() => requireLeadApiKey(env)).toThrow(/LEAD_API_KEY_CALLER is not configured/);
  });

  it('returns the key when it is configured', () => {
    const env = parseEnv(base({ LEAD_API_KEY_CALLER: 'a-test-key' }));

    expect(requireLeadApiKey(env)).toBe('a-test-key');
  });

  it('never echoes the key when another variable fails validation', () => {
    const run = () => parseEnv(base({ LEAD_API_KEY_CALLER: 'super-secret-key', PORT: 'nope' }));

    expect(run).toThrow(/PORT/);
    try {
      run();
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-key');
    }
  });

  it('disables automatic call eligibility by default', () => {
    expect(parseEnv(base()).LEAD_ELIGIBILITY_AUTO_ENABLED).toBe(false);
  });

  it('accepts the common spellings of the eligibility flag', () => {
    expect(
      parseEnv(base({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'true' })).LEAD_ELIGIBILITY_AUTO_ENABLED,
    ).toBe(true);
    expect(
      parseEnv(base({ LEAD_ELIGIBILITY_AUTO_ENABLED: '1' })).LEAD_ELIGIBILITY_AUTO_ENABLED,
    ).toBe(true);
    expect(
      parseEnv(base({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'no' })).LEAD_ELIGIBILITY_AUTO_ENABLED,
    ).toBe(false);
  });

  it('rejects a nonsense eligibility flag rather than defaulting it on', () => {
    expect(() => parseEnv(base({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'maybe' }))).toThrow();
  });

  it('ships a conservative default status blocklist', () => {
    expect(parseEnv(base()).LEAD_BLOCKED_STATUSES).toContain('Unsubscribe');
    expect(parseEnv(base()).LEAD_BLOCKED_STATUSES).toContain('Post Trip');
  });

  it('caps the page size at the documented maximum', () => {
    expect(() => parseEnv(base({ LEAD_API_PAGE_SIZE: '500' }))).toThrow(/LEAD_API_PAGE_SIZE/);
    expect(parseEnv(base({ LEAD_API_PAGE_SIZE: '200' })).LEAD_API_PAGE_SIZE).toBe(200);
  });

  it('bounds the retry budget', () => {
    expect(() => parseEnv(base({ LEAD_API_MAX_RETRIES: '99' }))).toThrow(/LEAD_API_MAX_RETRIES/);
  });

  it('rejects a non-ISO initial since value', () => {
    expect(() => parseEnv(base({ LEAD_POLL_INITIAL_SINCE: '14/10/2026' }))).toThrow(/ISO-8601/);
  });
});
