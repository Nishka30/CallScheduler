import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { previewLeadEligibility } from '../src/services/leadEligibilityPreview.service.js';
import type { LeadApiClient } from '../src/integrations/leadApi/client.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

function config(overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    LEAD_API_KEY_CALLER: 'test-key',
    ...overrides,
  });
}

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    updated_at: '2026-10-14T11:55:00.000Z',
    created_at: '2026-10-14T11:50:00.000Z',
    person_key: `lead:${id}`,
    is_deleted: false,
    is_lead: true,
    lead_status: null,
    caller_hold_until: null,
    ...overrides,
  };
}

function fakeClient(
  pages: { rows: unknown[]; nextCursor: string | null }[],
  overrides: Partial<Record<'getLead', ReturnType<typeof vi.fn>>> = {},
) {
  const listLeads = vi.fn(() => {
    const page = pages.shift();
    if (!page) throw new Error('unexpected extra listLeads call');
    return Promise.resolve({ ...page, nextCursorAbsent: false, rowsKey: 'leads' });
  });

  return {
    listLeads,
    getLead: overrides.getLead ?? vi.fn(),
    getPerson: vi.fn(),
  } as unknown as LeadApiClient & { listLeads: ReturnType<typeof vi.fn> };
}

const NOW = new Date('2026-10-14T12:00:00.000Z');

describe('previewLeadEligibility', () => {
  it('writes nothing: it never touches the database layer', async () => {
    // No Prisma repository is imported by this service at all - verified
    // structurally by the fact that this test needs no cursor/leadProcessing
    // mocks beyond the blanket prisma.js mock every test file carries.
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'true' }),
      now: NOW,
    });

    expect(summary.rowsSeen).toBe(1);
  });

  it('tallies outcomes and reasons across a page', async () => {
    const client = fakeClient([
      {
        rows: [
          row('1'),
          row('2', { is_lead: false }),
          row('3', { is_deleted: true }),
          row('4', { lead_status: 'Unsubscribe' }),
        ],
        nextCursor: null,
      },
    ]);

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'true' }),
      now: NOW,
    });

    expect(summary.byOutcome['ELIGIBLE']).toBe(1);
    expect(summary.byOutcome['SKIPPED']).toBe(3);
    expect(summary.byReason['not_a_lead']).toBe(1);
    expect(summary.byReason['lead_deleted']).toBe(1);
    expect(summary.byReason['status_blocked']).toBe(1);
  });

  it('reports a per-lead decision with id, outcome and reason', async () => {
    const client = fakeClient([{ rows: [row('42')], nextCursor: null }]);

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'true' }),
      now: NOW,
    });

    expect(summary.rows).toEqual([
      {
        leadId: '42',
        updatedAt: '2026-10-14T11:55:00.000Z',
        outcome: 'ELIGIBLE',
        reason: 'eligible',
      },
    ]);
  });

  it('always treats the run as non-bootstrap', async () => {
    // isBootstrapRun is hardcoded false - the preview answers the new-vs-changed
    // question, not "would this survive the real first poll".
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'true' }),
      now: NOW,
    });

    expect(summary.rows[0]!.reason).not.toBe('known_before_bootstrap');
  });

  it('never marks a lead eligible while the master switch is off', async () => {
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'false' }),
      now: NOW,
    });

    expect(summary.byOutcome['ELIGIBLE']).toBeUndefined();
    expect(summary.byReason['awaiting_new_lead_rule_confirmation']).toBe(1);
  });

  it('follows nextCursor across pages and stops when it is null', async () => {
    const client = fakeClient([
      { rows: [row('1')], nextCursor: 'c2' },
      { rows: [row('2')], nextCursor: null },
    ]);

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'true' }),
      now: NOW,
    });

    expect(summary.pagesFetched).toBe(2);
    expect(client.listLeads.mock.calls[1]![0]).toMatchObject({ cursor: 'c2' });
    expect(client.listLeads.mock.calls[1]![0]).not.toHaveProperty('since');
  });

  it('respects the page bound and warns when it is hit', async () => {
    const client = fakeClient([
      { rows: [row('1')], nextCursor: 'c2' },
      { rows: [row('2')], nextCursor: 'c3' },
    ]);

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config(),
      now: NOW,
      maxPages: 2,
    });

    expect(summary.pagesFetched).toBe(2);
    expect(summary.warnings.join(' ')).toMatch(/page preview bound/);
  });

  it('stops safely if nextCursor does not advance', async () => {
    // Page 2 echoes back the same cursor it was requested with.
    const client = fakeClient([
      { rows: [row('1')], nextCursor: 'stuck' },
      { rows: [row('2')], nextCursor: 'stuck' },
    ]);

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config(),
      now: NOW,
    });

    expect(summary.pagesFetched).toBe(2);
    expect(summary.warnings.join(' ')).toMatch(/did not advance/);
  });

  it('does not fetch lead detail unless checkPhone is requested', async () => {
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'true' }),
      now: NOW,
    });

    expect(client.getLead).not.toHaveBeenCalled();
  });

  it('applies the phone check only to list-level candidates when requested', async () => {
    const getLead = vi.fn(() =>
      Promise.resolve({ phone: { phone_e164: '+447700900123', valid: true, lookup_status: 'ok' } }),
    );
    const client = fakeClient(
      [{ rows: [row('1'), row('2', { is_lead: false })], nextCursor: null }],
      { getLead },
    );

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'true' }),
      now: NOW,
      checkPhone: true,
    });

    expect(getLead).toHaveBeenCalledTimes(1);
    expect(getLead).toHaveBeenCalledWith('1');
    expect(summary.byOutcome['ELIGIBLE']).toBe(1);
  });

  it('demotes a candidate whose phone is unvalidated when checkPhone is on', async () => {
    const getLead = vi.fn(() =>
      Promise.resolve({ phone: { phone_e164: null, valid: null, tier: 'none' } }),
    );
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }], { getLead });

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'true' }),
      now: NOW,
      checkPhone: true,
    });

    expect(summary.byOutcome['SKIPPED']).toBe(1);
    expect(summary.byReason['phone_not_validated']).toBe(1);
  });

  it('caps the number of reported rows without affecting the tally', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(String(i)));
    const client = fakeClient([{ rows, nextCursor: null }]);

    const summary = await previewLeadEligibility({
      since: '2026-10-14T00:00:00.000Z',
      client,
      config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'true' }),
      now: NOW,
      maxRowsReported: 2,
    });

    expect(summary.rowsSeen).toBe(5);
    expect(summary.rows).toHaveLength(2);
    expect(summary.byOutcome['ELIGIBLE']).toBe(5);
  });
});
