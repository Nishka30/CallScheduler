import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { createShutdownHandler } from './lib/shutdown.js';

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function registerProcessHandlers(server: Server): void {
  const shutdown = createShutdownHandler({
    closeServer: () => closeServer(server),
    disconnect: disconnectPrisma,
    exit: (code) => process.exit(code),
  });

  const run = (signal: string): void => {
    void shutdown(signal);
  };

  process.on('SIGTERM', () => {
    run('SIGTERM');
  });
  process.on('SIGINT', () => {
    run('SIGINT');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal(
      {
        err: reason instanceof Error ? { name: reason.name, message: reason.message } : undefined,
      },
      'unhandled promise rejection',
    );
    run('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: { name: error.name, message: error.message } }, 'uncaught exception');
    run('uncaughtException');
  });
}

function start(): void {
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'ai-caller server listening');
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.fatal({ port: env.PORT }, 'port already in use');
    } else {
      logger.fatal({ err: { message: error.message } }, 'HTTP server error');
    }
    process.exit(1);
  });

  registerProcessHandlers(server);
}

start();
