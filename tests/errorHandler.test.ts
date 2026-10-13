import { describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { AppError } from '../src/lib/errors.js';
import { requestId } from '../src/middleware/requestId.js';
import { notFoundHandler } from '../src/middleware/notFound.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

/** Minimal app wired with the real middleware under test. */
function buildTestApp(configure: (app: Express) => void): Express {
  const app = express();
  app.use(requestId);
  app.use(express.json({ limit: '1kb' }));
  configure(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('central error handling', () => {
  it('maps an AppError to its status code and stable error code', async () => {
    const app = buildTestApp((a) => {
      a.get('/boom', () => {
        throw AppError.conflict('Lead already claimed');
      });
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.message).toBe('Lead already claimed');
  });

  it('includes the correlation id in the error body', async () => {
    const app = buildTestApp((a) => {
      a.get('/boom', () => {
        throw AppError.badRequest('nope');
      });
    });

    const response = await request(app).get('/boom').set('x-request-id', 'trace-abc-12345');

    expect(response.body.error.requestId).toBe('trace-abc-12345');
  });

  it('hides the message and stack of an unexpected error', async () => {
    const app = buildTestApp((a) => {
      a.get('/boom', () => {
        throw new Error('DB password is hunter2 at /srv/app/src/secret.ts');
      });
    });

    const response = await request(app).get('/boom');
    const serialized = JSON.stringify(response.body);

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body.error.message).toBe('Internal server error');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('secret.ts');
    expect(response.body.error.stack).toBeUndefined();
  });

  it('forwards errors thrown in async handlers', async () => {
    const app = buildTestApp((a) => {
      a.get('/boom', async () => {
        await Promise.resolve();
        throw AppError.serviceUnavailable('dependency down');
      });
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('turns a ZodError into a 400 with field-level details', async () => {
    const schema = z.object({ leadId: z.string().min(1) });
    const app = buildTestApp((a) => {
      a.post('/leads', (req) => {
        schema.parse(req.body);
      });
    });

    const response = await request(app).post('/leads').send({ leadId: '' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details[0].path).toBe('leadId');
  });

  it('returns 400 for malformed JSON', async () => {
    const app = buildTestApp((a) => {
      a.post('/leads', (_req, res) => {
        res.json({ ok: true });
      });
    });

    const response = await request(app)
      .post('/leads')
      .set('Content-Type', 'application/json')
      .send('{"leadId":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 413 when the body exceeds the size limit', async () => {
    const app = buildTestApp((a) => {
      a.post('/leads', (_req, res) => {
        res.json({ ok: true });
      });
    });

    const response = await request(app)
      .post('/leads')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(5000) }));

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns a consistent 404 for unknown routes', async () => {
    const app = buildTestApp(() => {});

    const response = await request(app).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error).toHaveProperty('requestId');
  });
});
