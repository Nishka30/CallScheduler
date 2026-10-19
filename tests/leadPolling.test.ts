import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessingStatus } from '@prisma/client';
import { parseEnv } from '../src/config/env.js';
import { LeadApiError } from '../src/integrations/leadApi/errors.js';
import type { LeadApiClient } from '../src/integrations/leadApi/client.js';

/**
 * An in-memory stand-in for the two tables the poller touches, so cursor
 * durability and duplicate prevention can be asserted without a database.
 */
const db = {
  cursor: null as null | {
    source: string;
    cursor: string | null;
    watermarkAt: Date | null;
    lastAdvancedAt: Date | null;
    bootstrapCompletedAt: Date | null;
  },
  leads: new Map<string, { status: string; decisionReason: string | null; version: number }>(),
};

const advanceCursorSpy = vi.fn();

vi.mock('../src/repositories/integrationCursor.repository.js', () => ({
  LEAD_API_SOURCE: 'LEAD_API',
  getOrCreateCursor: () => {
    db.cursor ??= {
      source: 'LEAD_API',
      cursor: null,
      watermarkAt: null,
      lastAdvancedAt: null,
      bootstrapCompletedAt: null,
    };
    return Promise.resolve(db.cursor);
  },
  advanceCursor: (advance: { cursor: string | null; watermarkAt: Date | null }) => {
    advanceCursorSpy(advance);
    db.cursor!.cursor = advance.cursor;
    if (
      advance.watermarkAt &&
      (!db.cursor!.watermarkAt || advance.watermarkAt > db.cursor!.watermarkAt)
    ) {
      db.cursor!.watermarkAt = advance.watermarkAt;
    }
    return Promise.resolve(db.cursor!);
  },
  markBootstrapComplete: () => {
    db.cursor!.bootstrapCompletedAt = new Date();
    return Promise.resolve(db.cursor!);
  },
  isBootstrapPending: (c: { bootstrapCompletedAt: Date | null }) => c.bootstrapCompletedAt === null,
}));

vi.mock('../src/repositories/leadProcessing.repository.js', () => ({
  recordLeadDecision: (leadId: string, decision: { status: string; reason: string }) => {
    const existing = db.leads.get(leadId);
    if (existing) {
      // Already judged: the original decision stands.
      return Promise.resolve({ applied: false, record: existing });
    }
    const record = { status: decision.status, decisionReason: decision.reason, version: 1 };
    db.leads.set(leadId, record);
    return Promise.resolve({ applied: true, record });
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const { runLeadPoll } = await import('../src/services/leadPolling.service.js');

function config(overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    LEAD_API_KEY_CALLER: 'test-key',
    LEAD_ELIGIBILITY_AUTO_ENABLED: 'true',
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
    lead_status: 'New Lead',
    ...overrides,
  };
}

const DETAIL = {
  phone: {
    phone_e164: '+9779812345678',
    valid: true,
    tier: 'live_mobile',
    line_type: 'mobile',
    lookup_status: 'ok',
  },
  personKey: 'lead:1',
  answers: [],
};

/** Builds a fake client that serves the given pages in order. */
function fakeClient(
  pages: { rows: unknown[]; nextCursor: string | null }[],
  overrides: Partial<Record<'getLead' | 'getPerson', ReturnType<typeof vi.fn>>> = {},
) {
  const listLeads = vi.fn(() => {
    const page = pages.shift();
    if (!page) throw new Error('unexpected extra listLeads call');
    return Promise.resolve({ ...page, nextCursorAbsent: false, rowsKey: 'leads' });
  });

  return {
    listLeads,
    getLead: overrides.getLead ?? vi.fn(() => Promise.resolve(DETAIL)),
    getPerson: overrides.getPerson ?? vi.fn(() => Promise.resolve({ profile: {}, leads: [] })),
  } as unknown as LeadApiClient & { listLeads: ReturnType<typeof vi.fn> };
}

/** Marks bootstrap as already done so tests exercise normal operation. */
function seedCursor(cursor: string | null = null, watermarkAt: Date | null = null) {
  db.cursor = {
    source: 'LEAD_API',
    cursor,
    watermarkAt,
    lastAdvancedAt: null,
    bootstrapCompletedAt: new Date('2026-10-01T00:00:00.000Z'),
  };
}

beforeEach(() => {
  db.cursor = null;
  db.leads.clear();
  advanceCursorSpy.mockClear();
});

describe('bootstrap run', () => {
  it('records every pre-existing lead as known-before-bootstrap and calls none', async () => {
    const client = fakeClient([{ rows: [row('1'), row('2')], nextCursor: null }]);

    const summary = await runLeadPoll({ client, config: config() });

    expect(summary.bootstrap).toBe(true);
    expect(summary.byOutcome['SKIPPED']).toBe(2);
    expect([...db.leads.values()].map((l) => l.decisionReason)).toEqual([
      'known_before_bootstrap',
      'known_before_bootstrap',
    ]);
  });

  it('marks bootstrap complete so the next run evaluates leads normally', async () => {
    await runLeadPoll({
      client: fakeClient([{ rows: [row('1')], nextCursor: null }]),
      config: config(),
    });

    expect(db.cursor!.bootstrapCompletedAt).not.toBeNull();
  });

  it('never fetches lead details during bootstrap', async () => {
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    await runLeadPoll({ client, config: config() });

    expect(client.getLead).not.toHaveBeenCalled();
  });
});

describe('pagination', () => {
  it('follows nextCursor exactly and stops when it is null', async () => {
    seedCursor();
    const client = fakeClient([
      { rows: [row('1')], nextCursor: 'cursor-page-2' },
      { rows: [row('2')], nextCursor: null },
    ]);

    const summary = await runLeadPoll({ client, config: config() });

    expect(summary.pagesFetched).toBe(2);
    expect(client.listLeads.mock.calls[1]![0]).toMatchObject({ cursor: 'cursor-page-2' });
  });

  it('uses since on the first request and cursor afterwards, never both', async () => {
    seedCursor(null, new Date('2026-10-10T00:00:00.000Z'));
    const client = fakeClient([
      { rows: [row('1')], nextCursor: 'c2' },
      { rows: [row('2')], nextCursor: null },
    ]);

    await runLeadPoll({ client, config: config() });

    const first = client.listLeads.mock.calls[0]![0] as Record<string, unknown>;
    const second = client.listLeads.mock.calls[1]![0] as Record<string, unknown>;

    expect(first['since']).toBe('2026-10-10T00:00:00.000Z');
    expect(first['cursor']).toBeUndefined();
    expect(second['cursor']).toBe('c2');
    expect(second['since']).toBeUndefined();
  });

  it('resumes from a stored cursor instead of re-reading from since', async () => {
    seedCursor('stored-cursor');
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    await runLeadPoll({ client, config: config() });

    const first = client.listLeads.mock.calls[0]![0] as Record<string, unknown>;
    expect(first['cursor']).toBe('stored-cursor');
    expect(first['since']).toBeUndefined();
  });

  it('stops safely when the cursor does not advance, instead of looping', async () => {
    seedCursor('same-cursor');
    const client = fakeClient([{ rows: [row('1')], nextCursor: 'same-cursor' }]);

    await expect(runLeadPoll({ client, config: config() })).rejects.toBeInstanceOf(LeadApiError);
  });

  it('respects the maximum page bound', async () => {
    seedCursor();
    const client = fakeClient([
      { rows: [row('1')], nextCursor: 'c2' },
      { rows: [row('2')], nextCursor: 'c3' },
    ]);

    const summary = await runLeadPoll({ client, config: config({ LEAD_POLL_MAX_PAGES: '2' }) });

    expect(summary.pagesFetched).toBe(2);
    expect(summary.warnings.join(' ')).toMatch(/page bound/);
  });

  it('warns when a page carries no nextCursor key', async () => {
    seedCursor();
    const listLeads = vi.fn(() =>
      Promise.resolve({
        rows: [row('1')],
        nextCursor: null,
        nextCursorAbsent: true,
        rowsKey: 'leads',
      }),
    );
    const client = { listLeads, getLead: vi.fn(), getPerson: vi.fn() } as unknown as LeadApiClient;

    const summary = await runLeadPoll({ client, config: config(), fetchContext: false });

    expect(summary.warnings.join(' ')).toMatch(/no nextCursor/);
  });
});

describe('durable cursor advancement', () => {
  it('advances only after a page has been fully recorded', async () => {
    seedCursor();
    const order: string[] = [];
    advanceCursorSpy.mockImplementation(() => order.push('advance'));

    const client = fakeClient([{ rows: [row('1'), row('2')], nextCursor: null }], {
      getLead: vi.fn(() => {
        order.push('record');
        return Promise.resolve(DETAIL);
      }),
    });

    await runLeadPoll({ client, config: config() });

    // Both rows are handled before the single advance.
    expect(order).toEqual(['record', 'record', 'advance']);
  });

  it('does not advance the cursor when a page fails mid-processing', async () => {
    seedCursor('start');
    const client = fakeClient([{ rows: [row('1')], nextCursor: 'next' }], {
      getLead: vi.fn(() =>
        Promise.reject(new LeadApiError('server', 'upstream down', { path: '/x' })),
      ),
    });

    await expect(runLeadPoll({ client, config: config() })).rejects.toBeInstanceOf(LeadApiError);

    // The stored position is untouched, so the page is re-read next run.
    expect(advanceCursorSpy).not.toHaveBeenCalled();
    expect(db.cursor!.cursor).toBe('start');
  });

  it('advances page by page so a later failure keeps earlier progress', async () => {
    seedCursor();
    let call = 0;
    const listLeads = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          rows: [row('1')],
          nextCursor: 'c2',
          nextCursorAbsent: false,
          rowsKey: 'leads',
        });
      }
      return Promise.reject(new LeadApiError('server', 'boom', { path: '/x' }));
    });
    const client = { listLeads, getLead: vi.fn(), getPerson: vi.fn() } as unknown as LeadApiClient;

    await expect(
      runLeadPoll({ client, config: config(), fetchContext: false }),
    ).rejects.toBeInstanceOf(LeadApiError);

    expect(db.cursor!.cursor).toBe('c2');
  });

  it('records the highest updated_at on the page as the watermark', async () => {
    seedCursor();
    const client = fakeClient([
      {
        rows: [
          row('1', { updated_at: '2026-10-14T10:00:00.000Z' }),
          row('2', { updated_at: '2026-10-14T11:00:00.000Z' }),
        ],
        nextCursor: null,
      },
    ]);

    await runLeadPoll({ client, config: config(), fetchContext: false });

    expect(db.cursor!.watermarkAt).toEqual(new Date('2026-10-14T11:00:00.000Z'));
  });
});

describe('duplicate prevention', () => {
  it('decides a lead once even when it appears on two pages', async () => {
    seedCursor();
    const client = fakeClient([
      { rows: [row('1')], nextCursor: 'c2' },
      { rows: [row('1')], nextCursor: null },
    ]);

    const summary = await runLeadPoll({ client, config: config() });

    expect(summary.decisionsApplied).toBe(1);
    expect(summary.alreadyDecided).toBe(1);
    expect(db.leads.size).toBe(1);
  });

  it('does not re-decide a lead on a later polling cycle', async () => {
    seedCursor();
    await runLeadPoll({
      client: fakeClient([{ rows: [row('1')], nextCursor: null }]),
      config: config(),
    });

    const firstDecision = db.leads.get('1')!.decisionReason;

    // Same lead returns later because a note bumped updated_at.
    seedCursor();
    const summary = await runLeadPoll({
      client: fakeClient([
        {
          rows: [
            row('1', { lead_status: 'Processing Sales', updated_at: '2026-10-15T09:00:00.000Z' }),
          ],
          nextCursor: null,
        },
      ]),
      config: config(),
    });

    expect(summary.decisionsApplied).toBe(0);
    expect(summary.alreadyDecided).toBe(1);
    expect(db.leads.get('1')!.decisionReason).toBe(firstDecision);
  });
});

describe('context retrieval', () => {
  it('fetches detail and person history only for surviving candidates', async () => {
    seedCursor();
    const client = fakeClient([
      { rows: [row('1'), row('2', { is_deleted: true })], nextCursor: null },
    ]);

    await runLeadPoll({ client, config: config() });

    expect(client.getLead).toHaveBeenCalledTimes(1);
    expect(client.getPerson).toHaveBeenCalledTimes(1);
  });

  it('holds a lead for review when the phone verdict cannot be read', async () => {
    seedCursor();
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }], {
      getLead: vi.fn(() => Promise.resolve({ phone: { number: '+977981' }, personKey: 'lead:1' })),
    });

    await runLeadPoll({ client, config: config() });

    expect(db.leads.get('1')).toMatchObject({
      status: ProcessingStatus.NEEDS_REVIEW,
      decisionReason: 'phone_verdict_unreadable',
    });
  });

  it('holds a lead for review when no person key is available', async () => {
    seedCursor();
    const client = fakeClient([{ rows: [row('1', { person_key: null })], nextCursor: null }], {
      getLead: vi.fn(() =>
        Promise.resolve({ phone: { phone_e164: '+9779812345678', valid: true } }),
      ),
    });

    await runLeadPoll({ client, config: config() });

    expect(db.leads.get('1')!.decisionReason).toBe('person_key_absent');
    expect(client.getPerson).not.toHaveBeenCalled();
  });

  it('records a permanent 404 on person history as needing review, without retrying forever', async () => {
    seedCursor();
    const getPerson = vi.fn(() =>
      Promise.reject(new LeadApiError('not_found', 'missing', { path: '/p', status: 404 })),
    );
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }], { getPerson });

    await runLeadPoll({ client, config: config() });

    expect(getPerson).toHaveBeenCalledTimes(1);
    expect(db.leads.get('1')).toMatchObject({
      status: ProcessingStatus.NEEDS_REVIEW,
      decisionReason: 'context_lookup_failed',
    });
  });

  it('stops the run on a transient context failure, leaving the lead undecided', async () => {
    seedCursor();
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }], {
      getPerson: vi.fn(() =>
        Promise.reject(new LeadApiError('server', 'upstream down', { path: '/p', status: 503 })),
      ),
    });

    await expect(runLeadPoll({ client, config: config() })).rejects.toBeInstanceOf(LeadApiError);

    expect(db.leads.has('1')).toBe(false);
  });

  it('marks a fully verified new lead eligible', async () => {
    seedCursor();
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    await runLeadPoll({ client, config: config() });

    expect(db.leads.get('1')).toMatchObject({
      status: ProcessingStatus.ELIGIBLE,
      decisionReason: 'eligible',
    });
  });

  it('never marks a lead eligible while auto-eligibility is disabled', async () => {
    seedCursor();
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    await runLeadPoll({ client, config: config({ LEAD_ELIGIBILITY_AUTO_ENABLED: 'false' }) });

    expect(db.leads.get('1')).toMatchObject({
      status: ProcessingStatus.NEEDS_REVIEW,
      decisionReason: 'awaiting_new_lead_rule_confirmation',
    });
    expect(client.getLead).not.toHaveBeenCalled();
  });
});

describe('read-only guarantee', () => {
  it('uses only the three documented GET methods', async () => {
    seedCursor();
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    await runLeadPoll({ client, config: config() });

    // If a write method were ever added to the client, this would catch its use.
    const used = Object.keys(client).filter(
      (key) => typeof (client as unknown as Record<string, unknown>)[key] === 'function',
    );
    expect(used.sort()).toEqual(['getLead', 'getPerson', 'listLeads']);
  });
});

describe('orchestrator wiring (call step)', () => {
  it('does NOT invoke the call step when calling is disabled (normal poll path places no call)', async () => {
    seedCursor();
    const callInitiator = vi.fn();
    // Default config: RETELL_CALLING_ENABLED false. Even with eligibility on and
    // a fully eligible lead, the call step must never run.
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    const summary = await runLeadPoll({ client, config: config(), callInitiator });

    expect(callInitiator).not.toHaveBeenCalled();
    expect(summary.callsConsidered).toBe(0);
    expect(summary.byOutcome['ELIGIBLE']).toBe(1); // lead WAS eligible; just not called
  });

  it('does NOT invoke the call step when eligibility is on but calling is off', async () => {
    seedCursor();
    const callInitiator = vi.fn();
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    await runLeadPoll({
      client,
      config: config({ RETELL_CALLING_ENABLED: 'false' }),
      callInitiator,
    });

    expect(callInitiator).not.toHaveBeenCalled();
  });

  it('invokes the orchestrator for a freshly-ELIGIBLE lead when calling is enabled', async () => {
    seedCursor();
    const callInitiator = vi.fn().mockResolvedValue({ outcome: 'call_initiated', leadId: '1' });
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    const summary = await runLeadPoll({
      client,
      config: config({ RETELL_CALLING_ENABLED: 'true' }),
      callInitiator,
    });

    expect(callInitiator).toHaveBeenCalledTimes(1);
    expect(callInitiator.mock.calls[0]![0]).toBe('1'); // leadId
    expect(summary.callsConsidered).toBe(1);
    expect(summary.callOutcomes['call_initiated']).toBe(1);
  });

  it('passes the config and Lead API client through to the orchestrator', async () => {
    seedCursor();
    const callInitiator = vi
      .fn()
      .mockResolvedValue({ outcome: 'rejected_hold_expired', leadId: '1' });
    const client = fakeClient([{ rows: [row('1')], nextCursor: null }]);

    await runLeadPoll({
      client,
      config: config({ RETELL_CALLING_ENABLED: 'true' }),
      callInitiator,
    });

    const deps = callInitiator.mock.calls[0]![1] as { config: unknown; leadApiClient: unknown };
    expect(deps.config).toBeDefined();
    expect(deps.leadApiClient).toBe(client);
  });

  it('does not call ineligible / skipped leads', async () => {
    seedCursor();
    const callInitiator = vi.fn().mockResolvedValue({ outcome: 'call_initiated', leadId: 'x' });
    const client = fakeClient([
      { rows: [row('1', { is_deleted: true }), row('2', { is_lead: false })], nextCursor: null },
    ]);

    await runLeadPoll({
      client,
      config: config({ RETELL_CALLING_ENABLED: 'true' }),
      callInitiator,
    });

    expect(callInitiator).not.toHaveBeenCalled();
  });

  it('does not re-call a lead that was already decided on a prior run', async () => {
    seedCursor();
    const callInitiator = vi.fn().mockResolvedValue({ outcome: 'call_initiated', leadId: '1' });
    const cfg = config({ RETELL_CALLING_ENABLED: 'true' });

    await runLeadPoll({
      client: fakeClient([{ rows: [row('1')], nextCursor: null }]),
      config: cfg,
      callInitiator,
    });
    expect(callInitiator).toHaveBeenCalledTimes(1);

    // Same lead reappears on a later poll (already decided) -> no second call.
    seedCursor();
    await runLeadPoll({
      client: fakeClient([{ rows: [row('1')], nextCursor: null }]),
      config: cfg,
      callInitiator,
    });
    expect(callInitiator).toHaveBeenCalledTimes(1);
  });
});
