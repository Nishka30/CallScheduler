import { PrismaClient } from '@prisma/client';
import { env, isProduction } from '../config/env.js';
import { logger } from './logger.js';

/**
 * True for the query-engine's standard "Unique constraint failed" message -
 * the signature of a P2002 the application already handles as a successful,
 * idempotent duplicate-insert resolution. Exported for a direct unit test;
 * matched on the stable wording Prisma itself uses, not on a table/column name,
 * so it stays correct across every unique constraint in the schema.
 */
export function isExpectedUniqueConstraintEvent(message: string): boolean {
  return message.includes('Unique constraint failed');
}

function createPrismaClient() {
  const client = new PrismaClient({
    // `warn`/`error` only, emitted as events so they go through our redacting
    // logger. Query logging is off: queries can contain lead personal data.
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
    datasources: { db: { url: env.DATABASE_URL } },
  });

  client.$on('warn', (event) => {
    logger.warn({ prisma: event.message }, 'prisma warning');
  });

  client.$on('error', (event) => {
    // The query engine emits this event for EVERY query error, including a
    // unique-constraint violation (P2002) that a repository function already
    // caught and resolved cleanly (e.g. `ensureProcessingRecord`,
    // `recordCallAttempt` racing a concurrent insert for the same lead - an
    // EXPECTED outcome of the idempotent-insert pattern used throughout this
    // codebase, not a failure). Logging those at `error` level would be noisy
    // and could mislead on-call review into treating a benign race as a defect.
    // Everything else still logs at `error`, unchanged.
    if (isExpectedUniqueConstraintEvent(event.message)) {
      logger.debug({ prisma: event.message }, 'prisma: handled unique-constraint race (expected)');
      return;
    }
    logger.error({ prisma: event.message }, 'prisma error');
  });

  return client;
}

export type AppPrismaClient = ReturnType<typeof createPrismaClient>;

/**
 * Single shared Prisma client for the whole process.
 *
 * In development `tsx watch` reloads modules, which would otherwise leak a new
 * connection pool per reload, so the instance is cached on `globalThis`.
 */
const globalForPrisma = globalThis as unknown as { prisma?: AppPrismaClient };

export const prisma: AppPrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/** Closes the connection pool. Called from the graceful-shutdown path. */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
