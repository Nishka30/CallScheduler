import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export interface LivenessResult {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  checks: {
    database: {
      status: 'up' | 'down';
      latencyMs?: number;
    };
  };
  timestamp: string;
}

const SERVICE_NAME = 'ai-caller';

/** Liveness: the HTTP process is up. Deliberately touches no dependency. */
export function getLiveness(): LivenessResult {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

const DB_CHECK_TIMEOUT_MS = 2_000;

/**
 * Readiness: can we actually reach PostgreSQL?
 *
 * Failure details are logged but never returned - the caller gets only
 * up/down, so connection strings, SQL, and stack traces stay internal.
 */
export async function getReadiness(): Promise<ReadinessResult> {
  const startedAt = process.hrtime.bigint();

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, DB_CHECK_TIMEOUT_MS);

    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    return {
      status: 'ready',
      checks: { database: { status: 'up', latencyMs: Math.round(latencyMs) } },
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? { name: error.name, message: error.message } : undefined },
      'readiness check failed: database unreachable',
    );

    return {
      status: 'not_ready',
      checks: { database: { status: 'down' } },
      timestamp: new Date().toISOString(),
    };
  }
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Database check timed out after ${ms}ms`));
    }, ms);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Database check failed'));
      },
    );
  });
}
