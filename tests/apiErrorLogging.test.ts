import { describe, expect, it } from 'vitest';
import {
  LeadApiError,
  describeLeadApiError,
  sanitizeLeadApiPath,
} from '../src/integrations/leadApi/errors.js';
import { RetellApiError, describeRetellError } from '../src/integrations/retell/errors.js';

describe('sanitizeLeadApiPath', () => {
  it('templates identifier segments (person key can be an email → PII)', () => {
    // encodeURIComponent('email:foo@bar.com') — must never survive into a log.
    expect(sanitizeLeadApiPath('/api/crm/persons/email%3Afoo%40bar.com')).toBe(
      '/api/crm/persons/:personKey',
    );
    expect(sanitizeLeadApiPath('/api/crm/leads/7b4f404d-6a0b')).toBe('/api/crm/leads/:leadId');
    expect(sanitizeLeadApiPath('/api/crm/leads/abc/team-slots')).toBe(
      '/api/crm/leads/:leadId/team-slots',
    );
    expect(sanitizeLeadApiPath('/api/crm/appointments/123')).toBe('/api/crm/appointments/:id');
    expect(sanitizeLeadApiPath('/api/crm/leads')).toBe('/api/crm/leads'); // collection path untouched
  });
});

describe('describeLeadApiError', () => {
  it('classifies a timeout as a transient network error with a timedOut flag, no PII in the path', () => {
    const e = new LeadApiError('network', 'Lead API request timed out after 10000ms', {
      path: '/api/crm/persons/email%3Afoo%40bar.com',
    });
    const info = describeLeadApiError(e);
    expect(info).toMatchObject({
      kind: 'network',
      permanent: false, // network is retryable
      timedOut: true,
      path: '/api/crm/persons/:personKey',
    });
    expect(JSON.stringify(info)).not.toContain('foo');
    expect(JSON.stringify(info)).not.toContain('bar');
  });

  it('classifies a 404 as a permanent not_found error', () => {
    const info = describeLeadApiError(
      new LeadApiError('not_found', 'Lead API returned 404', {
        path: '/api/crm/leads/abc',
        status: 404,
      }),
    );
    expect(info).toMatchObject({
      kind: 'not_found',
      status: 404,
      permanent: true,
      path: '/api/crm/leads/:leadId',
    });
    expect(info.timedOut).toBeUndefined(); // only set for network
  });

  it('surfaces contract issues (paths + codes only) and marks them permanent', () => {
    const info = describeLeadApiError(
      new LeadApiError('contract', 'did not match the documented shape', {
        path: '/api/crm/leads/abc/team-slots',
        issues: ['decision.owner: invalid_type'],
      }),
    );
    expect(info.kind).toBe('contract');
    expect(info.permanent).toBe(true);
    expect(info.issues).toEqual(['decision.owner: invalid_type']);
  });
});

describe('describeRetellError', () => {
  it('reports a pre-dial 4xx as a non-uncertain client error with its status', () => {
    const info = describeRetellError(
      new RetellApiError('client', 'Retell create-call returned 422', {
        path: '/v2/create-phone-call',
        status: 422,
      }),
    );
    expect(info).toEqual({
      kind: 'client',
      status: 422,
      path: '/v2/create-phone-call',
      uncertain: false,
      preflight: false,
    });
  });

  it('flags a network failure as uncertain (may have placed the call)', () => {
    const info = describeRetellError(
      new RetellApiError('network', 'timed out', { path: '/v2/create-phone-call' }),
    );
    expect(info.uncertain).toBe(true);
    expect(info.preflight).toBe(false);
  });

  it('flags a config refusal as pre-flight (no request made)', () => {
    const info = describeRetellError(
      new RetellApiError('config', 'missing agent id', { path: '/v2/create-phone-call' }),
    );
    expect(info.preflight).toBe(true);
    expect(info.uncertain).toBe(false);
  });
});
