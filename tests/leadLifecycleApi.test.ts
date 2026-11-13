import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Set before the app (and its env) load: the auth middleware reads the key at
// request time, parsed from process.env at module load.
vi.stubEnv('CALL_READ_API_KEY', 'test-read-key');

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const getLeadLifecycleTrace = vi.fn();
vi.mock('../src/services/leadLifecycle.service.js', () => ({
  getLeadLifecycleTrace: (...a: unknown[]) => getLeadLifecycleTrace(...a),
}));

const { createApp } = await import('../src/app.js');
const app = createApp();

const BEARER = 'Bearer test-read-key';

afterEach(() => {
  getLeadLifecycleTrace.mockReset();
});

describe('GET /api/leads/:leadId/lifecycle — auth', () => {
  it('401s without a bearer token', async () => {
    const res = await request(app).get('/api/leads/lead-1/lifecycle');
    expect(res.status).toBe(401);
    expect(getLeadLifecycleTrace).not.toHaveBeenCalled();
  });

  it('401s with the wrong token', async () => {
    const res = await request(app).get('/api/leads/lead-1/lifecycle').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/leads/:leadId/lifecycle', () => {
  it('returns the summary and events in chronological order', async () => {
    getLeadLifecycleTrace.mockResolvedValue({
      lead: { leadId: 'lead-1', status: 'SKIPPED', decisionReason: 'crm_route_excluded', crmRoute: 'legacy' },
      events: [
        { id: 'e1', event: 'lead_received', status: 'RECEIVED', reason: null, detail: null, metadata: {}, createdAt: '2026-11-14T10:00:04.000Z' },
        { id: 'e2', event: 'crm_gate_checked', status: 'rejected', reason: 'crm_route_excluded', detail: 'legacy', metadata: { crmRoute: 'legacy' }, createdAt: '2026-11-14T10:00:06.000Z' },
      ],
    });

    const res = await request(app).get('/api/leads/lead-1/lifecycle').set('Authorization', BEARER);

    expect(res.status).toBe(200);
    expect(res.body.lead).toMatchObject({ leadId: 'lead-1', status: 'SKIPPED' });
    expect(res.body.events.map((e: { event: string }) => e.event)).toEqual([
      'lead_received',
      'crm_gate_checked',
    ]);
    const times = res.body.events.map((e: { createdAt: string }) => e.createdAt);
    expect([...times].sort()).toEqual(times); // already ascending
    expect(getLeadLifecycleTrace).toHaveBeenCalledWith('lead-1');
  });

  it('404s when nothing is known about the lead', async () => {
    getLeadLifecycleTrace.mockResolvedValue({ lead: null, events: [] });
    const res = await request(app).get('/api/leads/ghost/lifecycle').set('Authorization', BEARER);
    expect(res.status).toBe(404);
  });

  it('200s for a lead that exists but has no events yet', async () => {
    getLeadLifecycleTrace.mockResolvedValue({
      lead: { leadId: 'lead-2', status: 'PENDING' },
      events: [],
    });
    const res = await request(app).get('/api/leads/lead-2/lifecycle').set('Authorization', BEARER);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });

  it('400s on an over-long lead id', async () => {
    const res = await request(app)
      .get(`/api/leads/${'x'.repeat(200)}/lifecycle`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(400);
    expect(getLeadLifecycleTrace).not.toHaveBeenCalled();
  });
});

describe('GET /lead-trace — page', () => {
  it('serves the self-contained HTML page unauthenticated', async () => {
    const res = await request(app).get('/lead-trace');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Lead Lifecycle');
    // relaxed, same-origin-only CSP for this one page
    expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
  });
});
