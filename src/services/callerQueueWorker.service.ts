import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { sanitizeErrorMessage } from '../repositories/leadProcessing.repository.js';
import { runCallerQueuePoll, type CallerQueuePollSummary } from './callerQueue.service.js';
import { buildStatusReconciliationSweeper } from './statusReconciliation.service.js';
import { buildDeadlineMonitorSweeper } from './deadlineMonitor.service.js';
import { buildFinalizationSweeper } from './queueFinalization.service.js';

/**
 * Background worker that polls the Guided Boost caller queue on a timer when
 * `CALLER_QUEUE_ENABLED` is true, using `CALLER_QUEUE_POLL_INTERVAL_MS` as the
 * interval. It only schedules `runCallerQueuePoll()`; it adds no polling/ingestion
 * logic of its own.
 *
 * Mirrors the LeadWorker safety structure (self-rescheduling timer, in-flight
 * guard so cycles never overlap, bounded backoff on failure, graceful stop) but is
 * deliberately trimmed to the queue's needs. Duplicate protection and call-safety
 * live in the ingestion service + the database, not here.
 */

export interface CallerQueueWorkerStatus {
  enabled: boolean;
  running: boolean;
  polling: boolean;
  startedAt?: string;
  lastPollStartedAt?: string;
  lastPollFinishedAt?: string;
  lastPollOk?: boolean;
  lastError?: string;
  consecutiveErrors: number;
  cyclesCompleted: number;
  lastSummary?: CallerQueuePollSummary;
  intervalMs: number;
}

export interface CallerQueueWorkerOptions {
  intervalMs: number;
  maxBackoffMs: number;
  /** The poll step; defaults to the real `runCallerQueuePoll`. Injected in tests. */
  runPoll?: () => Promise<CallerQueuePollSummary>;
  /**
   * Optional post-poll sweep, run AFTER a successful poll in the same (non-
   * overlapping) cycle. Its errors are contained so a sweep failure never marks the
   * poll cycle failed. Used for the QUEUE final-status reconciliation. Absent = none.
   */
  runSweep?: () => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class CallerQueueWorker {
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly runPoll: () => Promise<CallerQueuePollSummary>;
  private readonly runSweep: (() => Promise<void>) | undefined;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private inFlight: Promise<void> | null = null;
  private status: CallerQueueWorkerStatus;

  constructor(options: CallerQueueWorkerOptions) {
    this.intervalMs = options.intervalMs;
    this.maxBackoffMs = options.maxBackoffMs;
    this.runPoll = options.runPoll ?? (() => runCallerQueuePoll());
    this.runSweep = options.runSweep;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
    this.status = {
      enabled: true,
      running: false,
      polling: false,
      consecutiveErrors: 0,
      cyclesCompleted: 0,
      intervalMs: this.intervalMs,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.status.running = true;
    this.status.startedAt = new Date(this.now()).toISOString();
    logger.info({ intervalMs: this.intervalMs }, 'caller queue worker started');
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.status.running = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
    logger.info('caller queue worker stopped');
  }

  getStatus(): CallerQueueWorkerStatus {
    return { ...this.status };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.inFlight) return;
      this.inFlight = this.runCycle().finally(() => {
        this.inFlight = null;
        this.schedule(this.nextDelay());
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private nextDelay(): number {
    if (this.status.consecutiveErrors === 0) return this.intervalMs;
    const factor = 2 ** Math.min(this.status.consecutiveErrors, 16);
    return Math.min(this.intervalMs * factor, this.maxBackoffMs);
  }

  private async runCycle(): Promise<void> {
    if (this.stopped) return;
    this.status.polling = true;
    this.status.lastPollStartedAt = new Date(this.now()).toISOString();
    try {
      const summary = await this.runPoll();
      this.status.consecutiveErrors = 0;
      this.status.lastPollOk = true;
      this.status.cyclesCompleted += 1;
      this.status.lastSummary = summary;
      delete this.status.lastError;
      logger.debug(
        { fetched: summary.fetched, outcome: summary.outcome },
        'caller queue worker: poll cycle complete',
      );

      // Post-poll sweep (QUEUE final-status reconciliation). Error-contained so a
      // sweep failure never marks the poll cycle failed or triggers poll backoff.
      if (this.runSweep) {
        try {
          await this.runSweep();
        } catch (error) {
          logger.error(
            { err: sanitizeErrorMessage(error) },
            'caller queue worker: status reconciliation sweep failed (poll cycle unaffected)',
          );
        }
      }
    } catch (error) {
      this.status.consecutiveErrors += 1;
      this.status.lastPollOk = false;
      this.status.lastError = sanitizeErrorMessage(error);
      logger.error(
        { consecutiveErrors: this.status.consecutiveErrors, nextDelayMs: this.nextDelay() },
        'caller queue worker: poll cycle failed; backing off',
      );
    } finally {
      this.status.polling = false;
      this.status.lastPollFinishedAt = new Date(this.now()).toISOString();
    }
  }
}

let active: CallerQueueWorker | null = null;

/**
 * Starts the process-wide caller queue worker from config, if
 * `CALLER_QUEUE_ENABLED`. Returns the worker (or null when disabled). Safe to call
 * once at startup. Dialling still requires `RETELL_CALLING_ENABLED` (enforced in
 * the ingestion service), so enabling the worker alone never places a call.
 */
export function startCallerQueueWorker(config: Env = env): CallerQueueWorker | null {
  if (!config.CALLER_QUEUE_ENABLED) {
    logger.info('caller queue worker disabled (CALLER_QUEUE_ENABLED=false); no queue polling');
    return null;
  }
  if (active) return active;

  // Optional post-poll sweeps, each independently flagged and error-contained.
  const deadlineMonitor = buildDeadlineMonitorSweeper(config);
  if (deadlineMonitor) {
    logger.info(
      { leadMs: config.CALLER_IN_PROGRESS_LEAD_MS },
      'caller queue worker: active-call deadline monitor enabled',
    );
  }
  const statusSweeper = buildStatusReconciliationSweeper(config);
  if (statusSweeper) {
    logger.info(
      {
        maxAttempts: config.CALLER_STATUS_RETRY_MAX_ATTEMPTS,
        backoffMs: config.CALLER_STATUS_RETRY_BACKOFF_MS,
      },
      'caller queue worker: Guided Boost status-report reconciliation enabled',
    );
  }

  // Finalization is CORE to the queue flow (it is how a terminal call's final status
  // is actually sent), so it always runs with the queue worker — not behind a flag.
  const finalizationSweeper = buildFinalizationSweeper(config);

  const sweeps: Array<{ label: string; run: () => Promise<unknown> }> = [];
  if (deadlineMonitor)
    sweeps.push({ label: 'deadline monitor', run: () => deadlineMonitor.runSweep() });
  sweeps.push({ label: 'finalization', run: () => finalizationSweeper.runSweep() });
  if (statusSweeper)
    sweeps.push({ label: 'status reconciliation', run: () => statusSweeper.runSweep() });

  const runSweep =
    sweeps.length > 0
      ? async () => {
          for (const sweep of sweeps) {
            try {
              await sweep.run();
            } catch (error) {
              logger.error(
                { err: sanitizeErrorMessage(error) },
                `caller queue worker: ${sweep.label} sweep failed (cycle unaffected)`,
              );
            }
          }
        }
      : undefined;

  const worker = new CallerQueueWorker({
    intervalMs: config.CALLER_QUEUE_POLL_INTERVAL_MS,
    maxBackoffMs: config.LEAD_WORKER_MAX_BACKOFF_MS,
    ...(runSweep ? { runSweep } : {}),
  });
  worker.start();
  active = worker;
  return worker;
}

/** Stops the process-wide queue worker (for graceful shutdown). */
export async function stopCallerQueueWorker(): Promise<void> {
  if (!active) return;
  await active.stop();
  active = null;
}
