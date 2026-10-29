import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Must be set before the app (and its env) are imported — the auth middleware
// reads env.CALL_READ_API_KEY at request time, parsed from process.env at load.
vi.stubEnv('CALL_READ_API_KEY', 'test-read-key');

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const listCallRecords = vi.fn();
const getCallRecordDetail = vi.fn();
vi.mock('../src/repositories/callRecord.repository.js', () => ({
  listCallRecords: (...a: unknown[]) => listCallRecords(...a),
  getCallRecordDetail: (...a: unknown[]) => getCallRecordDetail(...a),
}));

const { createApp } = await import('../src/app.js');
const app = createApp();

const BEARER = 'Bearer test-read-key';

afterEach(() => {
  listCallRecords.mockReset();
  getCallRecordDetail.mockReset();
});

describe('GET /api/calls — auth', () => {
  it('401s without a bearer token', async () => {
    const res = await request(app).get('/api/calls');
    expect(res.status).toBe(401);
    expect(listCallRecords).not.toHaveBeenCalled();
  });

  it('401s with the wrong token', async () => {
    const res = await request(app).get('/api/calls').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/calls — list', () => {
  it('returns the summary page and passes filters through', async () => {
    listCallRecords.mockResolvedValue({
      items: [{ id: 'c1', leadId: 'lead-1', status: 'COMPLETED' }],
      nextCursor: 'c1',
    });

    const res = await request(app)
      .get('/api/calls?limit=10&status=COMPLETED&leadId=lead-1')
      .set('Authorization', BEARER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [{ id: 'c1', leadId: 'lead-1', status: 'COMPLETED' }],
      nextCursor: 'c1',
    });
    const [filter, pagination] = listCallRecords.mock.calls[0]!;
    expect(filter).toMatchObject({ leadId: 'lead-1', status: 'COMPLETED' });
    expect(pagination).toMatchObject({ limit: 10 });
  });

  it('400s on an invalid filter value', async () => {
    const res = await request(app).get('/api/calls?status=BOGUS').set('Authorization', BEARER);
    expect(res.status).toBe(400);
    expect(listCallRecords).not.toHaveBeenCalled();
  });

  it('400s on an out-of-range limit', async () => {
    const res = await request(app).get('/api/calls?limit=0').set('Authorization', BEARER);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/calls/:id — detail', () => {
  it('returns the full record including transcript and analysis', async () => {
    getCallRecordDetail.mockResolvedValue({
      id: 'c1',
      leadId: 'lead-1',
      retellCallId: 'call_abc',
      status: 'COMPLETED',
      transcript: 'Agent: Hi\nUser: Hello',
      analysis: { user_sentiment: 'Positive' },
    });

    const res = await request(app).get('/api/calls/c1').set('Authorization', BEARER);

    expect(res.status).toBe(200);
    expect(res.body.transcript).toContain('Agent: Hi');
    expect(res.body.analysis).toMatchObject({ user_sentiment: 'Positive' });
    expect(getCallRecordDetail).toHaveBeenCalledWith('c1');
  });

  it('404s when the call is not found', async () => {
    getCallRecordDetail.mockResolvedValue(null);
    const res = await request(app).get('/api/calls/call_missing').set('Authorization', BEARER);
    expect(res.status).toBe(404);
  });
});
