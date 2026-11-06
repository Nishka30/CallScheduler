import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { sanitizeErrorMessage } from '../repositories/leadProcessing.repository.js';
import { runLeadPoll, type PollSummary } from './leadPolling.service.js';
import { buildReevaluationSweeper } from './leadReevaluationSweep.service.js';
import { buildRetrySweeper } from './retrySweep.service.js';
import { buildCallReconciliationSweeper } from './callReconciliation.service.js';
import { buildNoteReconciliationSweeper } from './noteReconciliation.service.js';
import { buildReviewNoteSweeper } from './reviewNoteDelivery.service.js';

/**
 * Background worker that runs the EXISTING `runLeadPoll()` on a timer, so leads
 * are detected, ingested, classified and (only when calling is enabled) handed to
 * the orchestrator without a manual CLI run. It adds NO new polling or calling
 * logic — `runLeadPoll` already does detection → eligibility → gated calling in a
 * single cycle; this just schedules it safely.
 *
 * Safety properties:
 *   - Cycles never overlap (self-rescheduling timer + an in-flight guard): the
 *     next cycle is scheduled only after the current one settles.
 *   - A failing cycle never kills the loop; it is logged (sanitised) and the next
 *     cycle is delayed with bounded exponential backoff.
 *   - Duplicate CALLS across restarts/replicas are prevented at the DATABASE by
 *     the existing layer (version-guarded `recordLeadDecision`/`claimEligibleLead`
 *     + the `call_records_active_leadId_key` unique index), independent of this
 *     worker. An optional advisory lock additionally stops replicas polling at
 *     once (redundant reads), but is not what guarantees call-uniqueness.
 *   - Stop is graceful: scheduling halts and an in-flight cycle is awaited.
 */

export interface LeadWorkerStatus {
  enabled: boolean;
  /** The loop is scheduled (started and not stopped). */
  running: boolean;
  /** A poll cycle is executing right now. */
  polling: boolean;
  startedAt?: string;
  lastPollStartedAt?: string;
  lastPollFinishedAt?: string;
  lastPollOk?: boolean;
  /** Sanitised message of the last failure (never a secret or PII). */
  lastError?: string;
  consecutiveErrors: number;
  cyclesCompleted: number;
  /** Safe, non-PII tallies from the most recent successful cycle. */
  lastSummary?: {
    rowsSeen: number;
    decisionsApplied: number;
    callsConsidered: number;
    callOutcomes: Record<string, number>;
  };
  intervalMs: number;
  nextPollInMs?: number;
}

/** Wraps a cycle so a deployment can serialise polling across replicas. */
export type PollLock = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

export interface LeadWorkerOptions {
  intervalMs: number;
  maxBackoffMs: number;
  /** The poll step; defaults to the real `runLeadPoll`. Injected in tests. */
  runPoll?: () => Promise<PollSummary>;
  /**
   * Optional NEEDS_REVIEW re-evaluation sweep, run AFTER a successful poll in
   * the same (non-overlapping) cycle. Its own errors are contained so a sweep
   * failure never marks the poll cycle failed. Absent = no automatic re-eval.
   */
  runSweep?: () => Promise<void>;
  /** Optional cross-process guard; default runs the cycle directly. */
  withLock?: PollLock;
  now?: () => number;
  /** Scheduler hooks, injected so tests can drive time deterministically. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class LeadWorker {
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly runPoll: () => Promise<PollSummary>;
  private readonly runSweep: (() => Promise<void>) | undefined;
  private readonly withLock: PollLock;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private inFlight: Promise<void> | null = null;
  private status: LeadWorkerStatus;

  constructor(options: LeadWorkerOptions) {
    this.intervalMs = options.intervalMs;
    this.maxBackoffMs = options.maxBackoffMs;
    this.runPoll = options.runPoll ?? (() => runLeadPoll());
    this.runSweep = options.runSweep;
    this.withLock = options.withLock ?? ((fn) => fn());
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

  /** Starts the loop (idempotent). The first cycle runs on the next tick. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.status.running = true;
    this.status.startedAt = new Date(this.now()).toISOString();
    logger.info({ intervalMs: this.intervalMs }, 'lead worker started');
    // Kick the first cycle promptly, but asynchronously so start() returns.
    this.schedule(0);
  }

  /** Stops scheduling and waits for any in-flight cycle to finish. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.status.running = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
    logger.info('lead worker stopped');
  }

  getStatus(): LeadWorkerStatus {
    return { ...this.status };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.status.nextPollInMs = delayMs;
    this.timer = this.setTimer(() => {
      this.timer = null;
      // Guard: never start a cycle while one is in flight.
      if (this.inFlight) return;
      this.inFlight = this.runCycle().finally(() => {
        this.inFlight = null;
        // Schedule the next cycle: normal interval, or backoff after failures.
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
      const summary = await this.withLock(() => this.runPoll());
      this.status.consecutiveErrors = 0;
      this.status.lastPollOk = true;
      this.status.cyclesCompleted += 1;
      delete this.status.lastError;
      if (summary) {
        this.status.lastSummary = {
          rowsSeen: summary.rowsSeen,
          decisionsApplied: summary.decisionsApplied,
          callsConsidered: summary.callsConsidered,
          callOutcomes: summary.callOutcomes,
        };
        logger.info(
          {
            rowsSeen: summary.rowsSeen,
            decisionsApplied: summary.decisionsApplied,
            callsConsidered: summary.callsConsidered,
            callOutcomes: summary.callOutcomes,
          },
          'lead worker: poll cycle complete',
        );

        // Re-evaluation sweep runs only after a real poll (lock held), in the
        // same non-overlapping cycle. Its errors are contained here so a sweep
        // failure can never mark the poll cycle failed or trigger poll backoff.
        if (this.runSweep) {
          try {
            await this.runSweep();
          } catch (error) {
            logger.error(
              { err: sanitizeErrorMessage(error) },
              'lead worker: re-evaluation sweep failed (poll cycle unaffected)',
            );
          }
        }
      } else {
        // Lock not acquired — another replica is polling. Not an error.
        logger.debug('lead worker: poll skipped (another worker holds the poll lock)');
      }
    } catch (error) {
      this.status.consecutiveErrors += 1;
      this.status.lastPollOk = false;
      this.status.lastError = sanitizeErrorMessage(error);
      logger.error(
        { consecutiveErrors: this.status.consecutiveErrors, nextDelayMs: this.nextDelay() },
        'lead worker: poll cycle failed; backing off',
      );
    } finally {
      this.status.polling = false;
      this.status.lastPollFinishedAt = new Date(this.now()).toISOString();
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton + optional Postgres advisory lock
// ---------------------------------------------------------------------------

/** Stable 2×int32 key for the poll advisory lock (arbitrary, app-scoped). */
const POLL_LOCK_KEY = 0x4149_4c44; // "AILD"

let active: LeadWorker | null = null;

/**
 * A cross-process poll lock using a transaction-scoped Postgres advisory lock.
 * If the lock cannot be taken, the cycle is skipped (returns undefined). The lock
 * is held for the whole cycle and released when the transaction settles.
 */
function advisoryLock(timeoutMs: number): PollLock {
  return async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    return prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(${POLL_LOCK_KEY}) AS locked`;
        if (rows[0]?.locked !== true) return undefined;
        return fn();
      },
      { timeout: timeoutMs, maxWait: 5_000 },
    );
  };
}

/**
 * Starts the process-wide lead worker from config, if `LEAD_WORKER_ENABLED`.
 * Returns the worker (or null when disabled). Safe to call once at startup.
 */
export function startLeadWorker(config: Env = env): LeadWorker | null {
  if (!config.LEAD_WORKER_ENABLED) {
    logger.info('lead worker disabled (LEAD_WORKER_ENABLED=false); no automatic polling');
    return null;
  }
  if (active) return active;

  // Optional bounded/throttled NEEDS_REVIEW re-evaluation, after each poll.
  const reevalSweeper = buildReevaluationSweeper(config);
  if (reevalSweeper) {
    logger.info(
      {
        retryIntervalMs: config.LEAD_REEVAL_RETRY_INTERVAL_MS,
        maxAttempts: config.LEAD_REEVAL_MAX_ATTEMPTS,
        maxPerCycle: config.LEAD_REEVAL_MAX_PER_CYCLE,
      },
      'lead worker: automatic NEEDS_REVIEW re-evaluation enabled',
    );
  }

  // Optional persistent, hold-aware no-answer call retry, after each poll.
  // COMPLETELY SEPARATE from the NEEDS_REVIEW re-evaluation above.
  const retrySweeper = buildRetrySweeper(config);
  if (retrySweeper) {
    logger.info(
      {
        intervalMs: config.LEAD_RETRY_INTERVAL_MS,
        maxAttempts: config.LEAD_RETRY_MAX_ATTEMPTS,
        maxPerCycle: config.LEAD_RETRY_MAX_PER_CYCLE,
      },
      'lead worker: no-answer call retry enabled',
    );
  }

  // Optional reconciliation sweeps (recover stranded leads + redeliver failed notes).
  const callReconcileSweeper = buildCallReconciliationSweeper(config);
  const noteReconcileSweeper = buildNoteReconciliationSweeper(config);
  if (callReconcileSweeper || noteReconcileSweeper) {
    logger.info(
      {
        stuckCallingMs: config.LEAD_STUCK_CALLING_MS,
        stuckProcessingMs: config.LEAD_STUCK_PROCESSING_MS,
        eligibleBackstopMs: config.LEAD_ELIGIBLE_BACKSTOP_MS,
        noteRetryMaxAttempts: config.LEAD_NOTE_RETRY_MAX_ATTEMPTS,
      },
      'lead worker: reconciliation sweeps enabled',
    );
  }

  // Compose the independent post-poll sweeps into one hook. Each is error-contained
  // so a failure in one never prevents the others (or the poll cycle).
  // Review-note delivery always runs when the worker runs: delivering a CRM review
  // note is safe and must be reliable (it carries no dialling risk).
  const reviewNoteSweeper = buildReviewNoteSweeper(config);

  const sweeps: Array<{ label: string; run: () => Promise<unknown> }> = [];
  if (reevalSweeper) sweeps.push({ label: 'NEEDS_REVIEW re-evaluation', run: () => reevalSweeper.runSweep() });
  if (retrySweeper) sweeps.push({ label: 'no-answer retry', run: () => retrySweeper.runSweep() });
  sweeps.push({ label: 'review-note delivery', run: () => reviewNoteSweeper.runSweep() });
  if (callReconcileSweeper)
    sweeps.push({ label: 'call reconciliation', run: () => callReconcileSweeper.runSweep() });
  if (noteReconcileSweeper)
    sweeps.push({ label: 'note reconciliation', run: () => noteReconcileSweeper.runSweep() });

  const runSweep =
    sweeps.length > 0
      ? async () => {
          for (const sweep of sweeps) {
            try {
              await sweep.run();
            } catch (error) {
              logger.error(
                { err: sanitizeErrorMessage(error) },
                `lead worker: ${sweep.label} sweep failed (cycle unaffected)`,
              );
            }
          }
        }
      : undefined;

  const worker = new LeadWorker({
    intervalMs: config.LEAD_WORKER_INTERVAL_MS,
    maxBackoffMs: config.LEAD_WORKER_MAX_BACKOFF_MS,
    ...(runSweep ? { runSweep } : {}),
    ...(config.LEAD_WORKER_USE_DB_LOCK
      ? { withLock: advisoryLock(config.LEAD_WORKER_MAX_BACKOFF_MS) }
      : {}),
  });
  worker.start();
  active = worker;
  return worker;
}

/** Stops the process-wide worker (for graceful shutdown). */
export async function stopLeadWorker(): Promise<void> {
  if (!active) return;
  await active.stop();
  active = null;
}

/** Worker status for the health endpoint, or a disabled placeholder. */
export function getLeadWorkerStatus(): LeadWorkerStatus {
  if (active) return active.getStatus();
  return {
    enabled: env.LEAD_WORKER_ENABLED,
    running: false,
    polling: false,
    consecutiveErrors: 0,
    cyclesCompleted: 0,
    intervalMs: env.LEAD_WORKER_INTERVAL_MS,
  };
}
