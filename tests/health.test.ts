import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The Prisma client is mocked for the whole file: these tests must never touch
// a real database or any external system.
const queryRaw = vi.fn();
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
  disconnectPrisma: vi.fn(),
}));

const { createApp } = await import('../src/app.js');
const app = createApp();

afterEach(() => {
  queryRaw.mockReset();
});

describe('GET /health (liveness)', () => {
  it('returns 200 without touching the database', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', service: 'ai-caller' });
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('stays healthy even when the database is unreachable', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'));

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
  });

  it('echoes a correlation id on the response', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses a well-formed incoming correlation id', async () => {
    const response = await request(app).get('/health').set('x-request-id', 'trace-abc-12345');

    expect(response.headers['x-request-id']).toBe('trace-abc-12345');
  });

  it('replaces a malformed incoming correlation id', async () => {
    const response = await request(app).get('/health').set('x-request-id', 'bad id!');

    expect(response.headers['x-request-id']).not.toBe('bad id!');
  });

  it('sets basic security headers', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('does not send a wildcard CORS header', async () => {
    const response = await request(app).get('/health').set('Origin', 'https://evil.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('GET /health/ready (readiness)', () => {
  it('returns 200 and ready when the database responds', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks.database.status).toBe('up');
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns 503 and not_ready when the database is unavailable', async () => {
    queryRaw.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5432'));

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks.database.status).toBe('down');
  });

  it('never leaks connection details or stack traces on failure', async () => {
    queryRaw.mockRejectedValue(
      new Error('Authentication failed for postgresql://admin:hunter2@db.internal:5432/prod'),
    );

    const response = await request(app).get('/health/ready');
    const serialized = JSON.stringify(response.body);

    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('db.internal');
    expect(response.body.error).toBeUndefined();
  });
});
