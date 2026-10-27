import { ProcessingStatus } from '@prisma/client';
import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { LeadApiClient } from '../integrations/leadApi/client.js';
import { LeadApiError } from '../integrations/leadApi/errors.js';
import type { LeadDetail, LeadListRow, PersonHistory } from '../integrations/leadApi/schemas.js';
import {
  advanceCursor,
  getOrCreateCursor,
  isBootstrapPending,
  markBootstrapComplete,
  LEAD_API_SOURCE,
} from '../repositories/integrationCursor.repository.js';
import { recordLeadDecision } from '../repositories/leadProcessing.repository.js';
import {
  evaluateListEligibility,
  evaluatePhoneEligibility,
  type EligibilityDecision,
} from './leadEligibility.service.js';
import { buildLeadCallContext, describeContextForLog } from './leadContext.service.js';
import { initiateCallForLead, type OrchestratorResult } from './callOrchestrator.service.js';

/** Signature of the call step, injectable so tests can observe/stub it. */
export type CallInitiator = (
  leadId: string,
  deps: { config: Env; leadApiClient: LeadApiClient },
) => Promise<OrchestratorResult>;

export interface PollSummary {
  pagesFetched: number;
  rowsSeen: number;
  decisionsApplied: number;
  alreadyDecided: number;
  byOutcome: Record<string, number>;
  /** How many freshly-ELIGIBLE leads the call step was invoked for this run. */
  callsConsidered: number;
  /** Tally of orchestrator outcomes (e.g. call_initiated, rejected_hold_expired). */
  callOutcomes: Record<string, number>;
  /** True when this run performed the initial backfill. */
  bootstrap: boolean;
  /** Cursor persisted at the end of the run. */
  finalCursor: string | null;
  /** Non-fatal problems, already sanitized. */
  warnings: string[];
}

export interface PollOptions {
  client?: LeadApiClient;
  config?: Env;
  now?: () => Date;
  /** Fetch lead detail + person history for candidates. Default true. */
  fetchContext?: boolean;
  /** Call step; defaults to the real orchestrator. Injected in tests. */
  callInitiator?: CallInitiator;
}

/**
 * Runs exactly one polling batch over the Lead API.
 *
 * Shape of a run:
 *   1. read the durable cursor,
 *   2. fetch a page (`since` on the first request, `cursor` thereafter),
 *   3. decide every row and record each decision durably,
 *   4. only then advance the cursor,
 *   5. repeat while `nextCursor` is non-null, up to a hard page bound.
 *
 * Nothing is called, and nothing is written to the CRM. The run only reads the
 * Lead API and updates our own processing and cursor rows.
 */
export async function runLeadPoll(options: PollOptions = {}): Promise<PollSummary> {
  const config = options.config ?? env;
  const now = options.now ?? (() => new Date());
  const client = options.client ?? new LeadApiClient({}, config);
  const fetchContext = options.fetchContext ?? true;
  const callInitiator = options.callInitiator ?? initiateCallForLead;

  const cursorRow = await getOrCreateCursor(LEAD_API_SOURCE);
  const bootstrap = isBootstrapPending(cursorRow);

  const summary: PollSummary = {
    pagesFetched: 0,
    rowsSeen: 0,
    decisionsApplied: 0,
    alreadyDecided: 0,
    byOutcome: {},
    callsConsidered: 0,
    callOutcomes: {},
    bootstrap,
    finalCursor: cursorRow.cursor,
    warnings: [],
  };

  // `since` seeds the very first request only; afterwards `cursor` drives
  // pagination. They are different parameters and are never interchanged.
  const since = resolveSince(cursorRow.watermarkAt, config, now());
  let cursor = cursorRow.cursor;
  let usedSince = false;

  logger.info(
    { bootstrap, hasCursor: cursor !== null, pageSize: config.LEAD_API_PAGE_SIZE },
    'lead poll starting',
  );

  for (let page = 0; page < config.LEAD_POLL_MAX_PAGES; page += 1) {
    const requestCursor = cursor ?? undefined;
    const requestSince = requestCursor === undefined ? since : undefined;
    if (requestSince !== undefined) usedSince = true;

    const result = await client.listLeads({
      ...(requestSince === undefined ? {} : { since: requestSince }),
      ...(requestCursor === undefined ? {} : { cursor: requestCursor }),
      brand: config.LEAD_API_BRAND ?? config.LEAD_TEST_BRAND,
      limit: config.LEAD_API_PAGE_SIZE,
    });

    summary.pagesFetched += 1;
    summary.rowsSeen += result.rows.length;

    if (result.nextCursorAbsent && result.rows.length > 0) {
      summary.warnings.push(
        'response carried no nextCursor key; treating this page as the last one',
      );
    }

    // Every row on the page is decided and committed BEFORE the cursor moves.
    // A crash here re-reads the page next run, which is harmless.
    let lastWatermark: Date | null = null;

    for (const row of result.rows) {
      const outcome = await processRow(row, {
        bootstrap,
        client,
        config,
        fetchContext,
        callInitiator,
        now: now(),
        summary,
      });
      summary.byOutcome[outcome] = (summary.byOutcome[outcome] ?? 0) + 1;

      const rowUpdatedAt = parseDate(row.updated_at);
      if (rowUpdatedAt && (!lastWatermark || rowUpdatedAt > lastWatermark)) {
        lastWatermark = rowUpdatedAt;
      }
    }

    // The page is now durably recorded, so the position may move.
    const advanced = await advanceCursor(
      { cursor: result.nextCursor, watermarkAt: lastWatermark },
      LEAD_API_SOURCE,
      now(),
    );
    summary.finalCursor = advanced.cursor;

    logger.info(
      {
        page: page + 1,
        rows: result.rows.length,
        rowsKey: result.rowsKey,
        hasNextPage: result.nextCursor !== null,
      },
      'lead poll page processed',
    );

    if (result.nextCursor === null) {
      break;
    }

    // A cursor that does not move would loop forever; stop instead of spinning.
    if (result.nextCursor === requestCursor) {
      throw new LeadApiError('contract', 'nextCursor did not advance; stopping to avoid a loop', {
        path: '/api/crm/leads',
      });
    }

    cursor = result.nextCursor;

    if (page === config.LEAD_POLL_MAX_PAGES - 1) {
      summary.warnings.push(
        `stopped at the ${String(config.LEAD_POLL_MAX_PAGES)}-page bound; the next run resumes from the stored cursor`,
      );
    }
  }

  if (bootstrap) {
    await markBootstrapComplete(LEAD_API_SOURCE, now());
    logger.warn(
      { rowsSeen: summary.rowsSeen },
      'bootstrap poll complete: pre-existing leads recorded as known-before-bootstrap and will never be auto-called',
    );
  }

  logger.info(
    {
      pages: summary.pagesFetched,
      rows: summary.rowsSeen,
      applied: summary.decisionsApplied,
      alreadyDecided: summary.alreadyDecided,
      byOutcome: summary.byOutcome,
      usedSince,
    },
    'lead poll finished',
  );

  return summary;
}

interface RowContext {
  bootstrap: boolean;
  client: LeadApiClient;
  config: Env;
  fetchContext: boolean;
  callInitiator: CallInitiator;
  now: Date;
  summary: PollSummary;
}

/**
 * Decides a single row and records the decision.
 *
 * List-level checks run first because they are free. Only a row that survives
 * them costs a detail lookup, and only then do we consult the phone verdict and
 * person history.
 */
async function processRow(row: LeadListRow, ctx: RowContext): Promise<string> {
  const leadId = row.id;
  const leadUpdatedAt = parseDate(row.updated_at);

  let decision: EligibilityDecision = evaluateListEligibility({
    row,
    isBootstrapRun: ctx.bootstrap,
    now: ctx.now,
    config: ctx.config,
  });

  // Only a surviving candidate justifies the extra reads.
  if (decision.outcome === 'ELIGIBLE' && ctx.fetchContext) {
    decision = await resolveWithContext(leadId, row, ctx.client);
  }

  const result = await recordLeadDecision(
    leadId,
    {
      status: toProcessingStatus(decision.outcome),
      reason: decision.reason,
      ...(decision.detail === undefined ? {} : { detail: decision.detail }),
      ...(leadUpdatedAt === null ? {} : { leadUpdatedAt }),
    },
    ctx.now,
  );

  if (result.applied) {
    ctx.summary.decisionsApplied += 1;
  } else {
    // Already judged on an earlier page or poll. Its original decision stands,
    // so a later note or status change cannot promote an old lead.
    ctx.summary.alreadyDecided += 1;
    return 'already_decided';
  }

  // Call step. Only a freshly-decided ELIGIBLE lead is handed to the
  // orchestrator, and ONLY when outbound calling is switched on. With
  // RETELL_CALLING_ENABLED=false (and with LEAD_ELIGIBILITY_AUTO_ENABLED=false
  // nothing even reaches ELIGIBLE), the orchestrator is never invoked, so the
  // normal poll path places no call. The orchestrator re-validates eligibility,
  // phone verdict and the active caller hold against fresh detail before any
  // dial, and records the attempt before contacting Retell.
  if (decision.outcome === 'ELIGIBLE' && ctx.config.RETELL_CALLING_ENABLED) {
    ctx.summary.callsConsidered += 1;
    const call = await ctx.callInitiator(leadId, {
      config: ctx.config,
      leadApiClient: ctx.client,
    });
    ctx.summary.callOutcomes[call.outcome] = (ctx.summary.callOutcomes[call.outcome] ?? 0) + 1;
  }

  return decision.outcome;
}

/**
 * Fetches lead detail and person history for a candidate, and folds the phone
 * verdict into the decision.
 *
 * A transient failure leaves the lead PENDING (by returning no decision change
 * it would be wrong to record), so it is reconsidered on the next poll rather
 * than being wrongly marked eligible with missing context.
 *
 * Exported (and taking just the client rather than a full `RowContext`) so the
 * EXACT same phone/person-key logic can be reused by the explicit NEEDS_REVIEW
 * re-evaluation path (`leadReevaluation.service.ts`) without duplicating it -
 * any future change here applies to both automatically.
 */
export async function resolveWithContext(
  leadId: string,
  row: LeadListRow,
  client: LeadApiClient,
): Promise<EligibilityDecision> {
  let detail: LeadDetail;

  try {
    detail = await client.getLead(leadId);
  } catch (error) {
    return contextFailureDecision(error, 'lead detail');
  }

  const phoneDecision = evaluatePhoneEligibility(detail);
  if (phoneDecision.outcome !== 'ELIGIBLE') {
    return phoneDecision;
  }

  const personKey = detail.personKey ?? row.person_key ?? undefined;
  if (!personKey) {
    // Documented as returned by both endpoints. Its absence is a contract
    // problem, not something to paper over with a guessed identity.
    logger.warn({ leadId }, 'lead has no personKey; cannot fetch person history');
    return {
      outcome: 'NEEDS_REVIEW',
      reason: 'person_key_absent',
      detail: 'neither the list row nor the lead detail provided a personKey',
    };
  }

  let history: PersonHistory;
  try {
    history = await client.getPerson(personKey);
  } catch (error) {
    return contextFailureDecision(error, 'person history');
  }

  const context = buildLeadCallContext(leadId, detail, { listRow: row, history });

  // Presence flags and counts only - the context holds personal data.
  logger.debug(describeContextForLog(context), 'lead call context prepared');

  return { outcome: 'ELIGIBLE', reason: 'eligible' };
}

/**
 * Turns a context-lookup failure into a decision.
 *
 * A permanent 4xx is recorded as NEEDS_REVIEW so it is not retried forever. A
 * transient failure is rethrown so the run stops and the lead stays PENDING,
 * to be retried on the next poll from the unadvanced cursor.
 */
function contextFailureDecision(error: unknown, what: string): EligibilityDecision {
  if (error instanceof LeadApiError && error.permanent) {
    return {
      outcome: 'NEEDS_REVIEW',
      reason: 'context_lookup_failed',
      detail: `${what} lookup failed permanently (${error.kind}${error.status ? ` ${String(error.status)}` : ''})`,
    };
  }

  throw error;
}

/** Exported for reuse by `leadReevaluation.service.ts` - one mapping, no drift. */
export function toProcessingStatus(
  outcome: EligibilityDecision['outcome'],
):
  | typeof ProcessingStatus.ELIGIBLE
  | typeof ProcessingStatus.SKIPPED
  | typeof ProcessingStatus.NEEDS_REVIEW {
  switch (outcome) {
    case 'ELIGIBLE':
      return ProcessingStatus.ELIGIBLE;
    case 'SKIPPED':
      return ProcessingStatus.SKIPPED;
    case 'NEEDS_REVIEW':
      return ProcessingStatus.NEEDS_REVIEW;
  }
}

/**
 * Chooses the `since` for the first request of a run.
 *
 * Prefers the durable watermark. With no watermark this is the bootstrap run,
 * where `LEAD_POLL_INITIAL_SINCE` (or "now") defines the boundary between
 * "existed before the AI Caller" and "arrived afterwards".
 */
function resolveSince(watermarkAt: Date | null, config: Env, now: Date): string {
  if (watermarkAt) return watermarkAt.toISOString();
  if (config.LEAD_POLL_INITIAL_SINCE) return new Date(config.LEAD_POLL_INITIAL_SINCE).toISOString();
  return now.toISOString();
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
