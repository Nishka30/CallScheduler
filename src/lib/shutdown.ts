import { logger } from './logger.js';

/** Hard cap on how long we wait for in-flight work before exiting anyway. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownDependencies {
  /** Stops accepting new connections and resolves once in-flight ones finish. */
  closeServer: () => Promise<void>;
  /** Releases the database connection pool. */
  disconnect: () => Promise<void>;
  /** Terminates the process. Injected so the behaviour can be unit tested. */
  exit: (code: number) => void;
  /**
   * Stops the background lead worker, awaiting any in-flight poll cycle. Called
   * FIRST so no new cycle (and no new call) can start while we tear down. A
   * failure here never blocks shutdown — it is logged and we continue.
   */
  stopWorker?: () => Promise<void>;
  timeoutMs?: number;
}

/**
 * Builds the graceful-shutdown routine.
 *
 * Ordering matters: the HTTP server is closed first so no new request can
 * reach the database, and only then is the connection pool released. The
 * returned function is idempotent - a second signal during shutdown is ignored
 * rather than starting a competing teardown.
 */
export function createShutdownHandler(
  deps: ShutdownDependencies,
): (signal: string) => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutdown signal received, closing server');

    // Exit even if a connection refuses to drain or the pool hangs.
    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs }, 'graceful shutdown timed out, forcing exit');
      deps.exit(1);
    }, timeoutMs);
    forceExit.unref?.();

    let exitCode = 0;

    if (deps.stopWorker) {
      try {
        await deps.stopWorker();
        logger.info('lead worker stopped');
      } catch (error) {
        // Never block shutdown on worker teardown; the force-exit timer remains.
        logger.error({ err: toLoggableError(error) }, 'error stopping lead worker');
      }
    }

    try {
      await deps.closeServer();
      logger.info('HTTP server closed');
    } catch (error) {
      exitCode = 1;
      logger.error({ err: toLoggableError(error) }, 'error closing HTTP server');
    }

    try {
      await deps.disconnect();
      logger.info('database client disconnected');
    } catch (error) {
      exitCode = 1;
      logger.error({ err: toLoggableError(error) }, 'error disconnecting database client');
    }

    clearTimeout(forceExit);
    deps.exit(exitCode);
  };
}

function toLoggableError(error: unknown): { name: string; message: string } | undefined {
  return error instanceof Error ? { name: error.name, message: error.message } : undefined;
}
