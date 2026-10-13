import { PrismaClient } from '@prisma/client';
import { env, isProduction } from '../config/env.js';
import { logger } from './logger.js';

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
