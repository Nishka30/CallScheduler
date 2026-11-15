import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  CallerStatusClient,
  type CallInProgressResult,
} from '../integrations/guidedBoost/callerStatus.client.js';
import {
  findActiveQueueCallsNearDeadline,
  claimCallInProgressSend,
  resetCallInProgressSend,
  updateCallBeforeAt,
  type DueDeadlineLead,
} from '../repositories/leadProcessing.repository.js';

/**
 * Active-call deadline monitor (Step 8) for QUEUE calls.
 *
 * As an active QUEUE call nears its authoritative `callBeforeAt`, this sends ONE
 * `call_in_progress` to Guided Boost. If Guided Boost extends the deadline it
 * returns the new `call_before`, which is persisted and used thereafter. Guided
 * Boost remains the owner of the eventual timeout.
 *
 * STRICT INVARIANTS (it imports nothing from the orchestrator/Retell, so these hold
 * structurally): it never initiates a call, never moves a lead to ELIGIBLE, never
 * calls `initiateCallForLead`, never touches the Step 5 source guards, and never
 * extends the deadline locally — only a Guided Boost response can change it.
 *
 * Once-only + concurrency + terminal-race are all enforced by one CAS
 * (`claimCallInProgressSend`, guarded on `status = CALLING` + `callInProgressSentAt
 * IS NULL`). A failed send releases the claim so a later cycle retries (a re-send is
 * safe — Guided Boost grants at most one extension server-side).
 */

export interface DeadlineMonitorConfig {
  /** How long before `callBeforeAt` to send `call_in_progress`. */
  leadMs: number;
  maxPerCycle: number;
  batchSize: number;
}

export interface DeadlineMonitorSummary {
  considered: number;
  extended: number;
  notExtended: number;
  conflict: number;
  failed: number;
  skippedClaim: number;
  errors: number;
}

export interface DeadlineMonitorDeps {
  findDue?: (now: Date, leadMs: number, limit: number) => Promise<DueDeadlineLead[]>;
  claim?: (leadId: string, now: Date) => Promise<boolean>;
  releaseClaim?: (leadId: string) => Promise<void>;
  persistDeadline?: (leadId: string, callBeforeAt: Date) => Promise<void>;
  statusClient?: CallerStatusClient;
  now?: () => number;
}

export class DeadlineMonitorSweeper {
  private readonly config: DeadlineMonitorConfig;
  private readonly findDue: NonNullable<DeadlineMonitorDeps['findDue']>;
  private readonly claim: NonNullable<DeadlineMonitorDeps['claim']>;
  private readonly releaseClaim: NonNullable<DeadlineMonitorDeps['releaseClaim']>;
  private readonly persistDeadline: NonNullable<DeadlineMonitorDeps['persistDeadline']>;
  private readonly client: CallerStatusClient;
  private readonly now: () => number;

  constructor(config: DeadlineMonitorConfig, deps: DeadlineMonitorDeps = {}, appConfig: Env = env) {
    this.config = config;
    this.findDue = deps.findDue ?? findActiveQueueCallsNearDeadline;
    this.claim = deps.claim ?? claimCallInProgressSend;
    this.releaseClaim = deps.releaseClaim ?? resetCallInProgressSend;
    this.persistDeadline = deps.persistDeadline ?? updateCallBeforeAt;
    this.client = deps.statusClient ?? new CallerStatusClient({}, appConfig);
    this.now = deps.now ?? (() => Date.now());
  }

  async runSweep(): Promise<DeadlineMonitorSummary> {
    const summary: DeadlineMonitorSummary = {
      considered: 0,
      extended: 0,
      notExtended: 0,
      conflict: 0,
      failed: 0,
      skippedClaim: 0,
      errors: 0,
    };

    const due = await this.findDue(
      new Date(this.now()),
      this.config.leadMs,
      this.config.batchSize,
    );
    summary.considered = due.length;

    let processed = 0;
    for (const lead of due) {
      if (processed >= this.config.maxPerCycle) break;
      processed += 1;

      // One atomic claim: once-only + single-winner + terminal-race guard. If a
      // terminal webhook already moved the lead out of CALLING, this matches nothing.
      const claimed = await this.claim(lead.leadId, new Date(this.now()));
      if (!claimed) {
        summary.skippedClaim += 1;
        continue;
      }

      let result: CallInProgressResult;
      try {
        result = await this.client.reportCallInProgress(lead.leadId);
      } catch (error) {
        // Defensive: the client handles expected failures; a programming error must
        // still leave the lead recoverable, never terminal, never locally extended.
        await this.safeRelease(lead.leadId);
        summary.errors += 1;
        logger.warn(
          { leadId: lead.leadId, err: error instanceof Error ? error.name : 'unknown' },
          'deadline monitor: call_in_progress raised unexpectedly; released for retry',
        );
        continue;
      }

      switch (result.outcome) {
        case 'extended':
          // Persist the AUTHORITATIVE new deadline from Guided Boost (never now+10m).
          if (result.callBefore) await this.persistDeadline(lead.leadId, result.callBefore);
          summary.extended += 1;
          break;
        case 'not_extended':
          // No extension available; preserve the current deadline. The claim stays
          // (once-only): we do not send call_in_progress again.
          summary.notExtended += 1;
          break;
        case 'conflict':
          // 409: the lead is already finalized on Guided Boost. Leave the claim set
          // (do not retry); the terminal webhook/final status remains authoritative.
          summary.conflict += 1;
          break;
        case 'failed':
          // Recoverable: release the claim so a later cycle retries. Never mark the
          // call terminal and never extend locally.
          await this.safeRelease(lead.leadId);
          summary.failed += 1;
          break;
      }
    }

    logger.info(summary, 'QUEUE deadline monitor sweep complete');
    return summary;
  }

  private async safeRelease(leadId: string): Promise<void> {
    try {
      await this.releaseClaim(leadId);
    } catch (error) {
      logger.warn(
        { leadId, err: error instanceof Error ? error.name : 'unknown' },
        'deadline monitor: could not release call_in_progress claim',
      );
    }
  }
}

/** Builds the deadline monitor from config, or null when disabled. */
export function buildDeadlineMonitorSweeper(config: Env = env): DeadlineMonitorSweeper | null {
  if (!config.CALLER_DEADLINE_MONITOR_ENABLED) return null;
  return new DeadlineMonitorSweeper(
    {
      leadMs: config.CALLER_IN_PROGRESS_LEAD_MS,
      maxPerCycle: config.LEAD_RECONCILE_MAX_PER_CYCLE,
      batchSize: config.LEAD_RECONCILE_BATCH_SIZE,
    },
    {},
    config,
  );
}
