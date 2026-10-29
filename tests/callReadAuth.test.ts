import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

// Mutable env mock so each test sets the configured key.
const env: { CALL_READ_API_KEY: string | undefined } = { CALL_READ_API_KEY: undefined };
vi.mock('../src/config/env.js', () => ({ env }));

const { requireCallReadAuth } = await import('../src/middleware/callReadAuth.js');

function res() {
  const r = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(payload: unknown) {
      r.body = payload;
      return r;
    },
  };
  return r;
}

function req(authorization?: string): Request {
  return {
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  } as unknown as Request;
}

beforeEach(() => {
  env.CALL_READ_API_KEY = undefined;
});

describe('requireCallReadAuth', () => {
  it('fails CLOSED (503) when no key is configured', () => {
    const r = res();
    const next = vi.fn();
    requireCallReadAuth(req('Bearer anything'), r as unknown as Response, next as NextFunction);
    expect(r.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s on a missing bearer token', () => {
    env.CALL_READ_API_KEY = 'secret';
    const r = res();
    const next = vi.fn();
    requireCallReadAuth(req(undefined), r as unknown as Response, next as NextFunction);
    expect(r.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s on the wrong token', () => {
    env.CALL_READ_API_KEY = 'secret';
    const r = res();
    const next = vi.fn();
    requireCallReadAuth(req('Bearer wrong'), r as unknown as Response, next as NextFunction);
    expect(r.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() on the correct token', () => {
    env.CALL_READ_API_KEY = 'secret';
    const r = res();
    const next = vi.fn();
    requireCallReadAuth(req('Bearer secret'), r as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    expect(r.statusCode).toBe(0);
  });
});
