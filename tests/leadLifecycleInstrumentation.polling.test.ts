import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import type { LeadApiClient } from '../src/integrations/leadApi/client.js';

// Lifecycle instrumentation for the poller. Mirrors leadPolling.test.ts's
// in-memory harness, and partially mocks the lifecycle service so only
// `recordLifecycle` is a spy.

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
    db.cursor!.cursor = advance.cursor;
    if (advance.watermarkAt && (!db.cursor!.watermarkAt || advance.watermarkAt > db.cursor!.watermarkAt)) {
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
    if (existing) return Promise.resolve({ applied: false, record: existing });
    const record = { status: decision.status, decisionReason: decision.reason, version: 1 };
    db.leads.set(leadId, record);
    return Promise.resolve({ applied: true, record });
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../src/services/reviewNoteDelivery.service.js', () => ({
  enqueueReviewNote: vi.fn().mockResolvedValue(true),
}));

const recordLifecycle = vi.fn().mockResolvedValue(true);
vi.mock('../src/services/leadLifecycle.service.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/leadLifecycle.service.js')>();
  return { ...actual, recordLifecycle: (...a: unknown[]) => recordLifecycle(...a) };
});

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
  phone: { phone_e164: '+9779812345678', valid: true, tier: 'live_mobile', line_type: 'mobile', lookup_status: 'ok' },
  personKey: 'lead:1',
  answers: [],
};

function fakeClient(pages: { rows: unknown[]; nextCursor: string | null }[]) {
  const listLeads = vi.fn(() => {
    const page = pages.shift();
    if (!page) throw new Error('unexpected extra listLeads call');
    return Promise.resolve({ ...page, nextCursorAbsent: false, rowsKey: 'leads' });
  });
  return {
    listLeads,
    getLead: vi.fn(() => Promise.resolve(DETAIL)),
    getPerson: vi.fn(() => Promise.resolve({ profile: {}, leads: [] })),
  } as unknown as LeadApiClient & { listLeads: ReturnType<typeof vi.fn> };
}

function seedCursor() {
  db.cursor = {
    source: 'LEAD_API',
    cursor: null,
    watermarkAt: null,
    lastAdvancedAt: null,
    bootstrapCompletedAt: new Date('2026-10-01T00:00:00.000Z'),
  };
}

function loggedFor(leadId: string) {
  return recordLifecycle.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e['leadId'] === leadId);
}

beforeEach(() => {
  db.cursor = null;
  db.leads.clear();
  recordLifecycle.mockClear();
  recordLifecycle.mockResolvedValue(true);
});

describe('poller lifecycle instrumentation', () => {
  it('records lead_received and an ELIGIBLE lead_decision for a fresh valid lead', async () => {
    seedCursor();
    await runLeadPoll({ client: fakeClient([{ rows: [row('1')], nextCursor: null }]), config: config() });

    const events = loggedFor('1');
    const received = events.find((e) => e['event'] === 'lead_received');
    const decision = events.find((e) => e['event'] === 'lead_decision');
    expect(received).toMatchObject({ status: 'RECEIVED' });
    expect(decision).toMatchObject({ status: 'ELIGIBLE' });
  });

  it('records a SKIPPED lead_decision with the real reason for a deleted lead', async () => {
    seedCursor();
    await runLeadPoll({
      client: fakeClient([{ rows: [row('2', { is_deleted: true })], nextCursor: null }]),
      config: config(),
    });

    const decision = loggedFor('2').find((e) => e['event'] === 'lead_decision');
    expect(decision).toMatchObject({ status: 'SKIPPED', reason: 'lead_deleted' });
  });

  it('records lead_received for every lead on the page', async () => {
    seedCursor();
    await runLeadPoll({
      client: fakeClient([{ rows: [row('3'), row('4')], nextCursor: null }]),
      config: config(),
    });
    expect(loggedFor('3').some((e) => e['event'] === 'lead_received')).toBe(true);
    expect(loggedFor('4').some((e) => e['event'] === 'lead_received')).toBe(true);
  });
});
