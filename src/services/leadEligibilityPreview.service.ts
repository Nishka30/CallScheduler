import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { LeadApiClient } from '../integrations/leadApi/client.js';
import {
  evaluateListEligibility,
  evaluatePhoneEligibility,
  type EligibilityOutcome,
} from './leadEligibility.service.js';

/**
 * Read-only eligibility preview.
 *
 * Deliberately separate from `leadPolling.service.ts` (the real poller) rather
 * than a mode flag on it: this function must never depend on the database, so
 * it can answer "which leads would be considered new" even before
 * `DATABASE_URL` points at a real, migrated database. It:
 *
 *   - reads the Lead API (GET only, same client as the real poller),
 *   - runs the same `evaluateListEligibility` / `evaluatePhoneEligibility`
 *     rules the real poller uses,
 *   - and writes NOTHING: no cursor, no LeadProcessing row, no CRM write.
 *
 * Running it twice with the same `since` produces the same answer every time.
 */

export interface EligibilityPreviewRow {
  leadId: string;
  updatedAt: string;
  outcome: EligibilityOutcome;
  reason: string;
  detail?: string;
}

export interface EligibilityPreviewSummary {
  /** The `since` this preview used - there is no durable watermark to read. */
  since: string;
  pagesFetched: number;
  rowsSeen: number;
  byOutcome: Record<string, number>;
  byReason: Record<string, number>;
  /** Per-lead decisions, capped at `maxRowsReported`. */
  rows: EligibilityPreviewRow[];
  checkedPhone: boolean;
  warnings: string[];
}

export interface EligibilityPreviewOptions {
  client?: LeadApiClient;
  config?: Env;
  now?: Date;
  /** Required and explicit: this preview never reads the durable watermark. */
  since: string;
  maxPages?: number;
  maxRowsReported?: number;
  /**
   * Also fetch lead detail and apply the phone-verdict check for list-level
   * candidates. Off by default to keep the preview to one read per lead.
   */
  checkPhone?: boolean;
}

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_ROWS_REPORTED = 500;

export async function previewLeadEligibility(
  options: EligibilityPreviewOptions,
): Promise<EligibilityPreviewSummary> {
  const config = options.config ?? env;
  const now = options.now ?? new Date();
  const client = options.client ?? new LeadApiClient({}, config);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxRowsReported = options.maxRowsReported ?? DEFAULT_MAX_ROWS_REPORTED;
  const checkPhone = options.checkPhone ?? false;

  const summary: EligibilityPreviewSummary = {
    since: options.since,
    pagesFetched: 0,
    rowsSeen: 0,
    byOutcome: {},
    byReason: {},
    rows: [],
    checkedPhone: checkPhone,
    warnings: [
      'PREVIEW ONLY: reads the Lead API but writes nothing - no cursor, no processing ' +
        'record, no CRM write, no call.',
      'isBootstrapRun is always false here. This answers "what would the new-vs-changed ' +
        'check decide for this row", not "what the real first poll would do" - bootstrap ' +
        'protection is a one-time property of the durable cursor, which this preview does ' +
        'not read or write.',
    ],
  };

  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await client.listLeads({
      ...(cursor === undefined ? { since: options.since } : { cursor }),
      limit: config.LEAD_API_PAGE_SIZE,
      ...(config.LEAD_API_BRAND === undefined ? {} : { brand: config.LEAD_API_BRAND }),
    });

    summary.pagesFetched += 1;
    summary.rowsSeen += result.rows.length;

    for (const row of result.rows) {
      let outcome: EligibilityOutcome;
      let reason: string;
      let detail: string | undefined;

      const listDecision = evaluateListEligibility({ row, isBootstrapRun: false, now, config });
      outcome = listDecision.outcome;
      reason = listDecision.reason;
      detail = listDecision.detail;

      if (checkPhone && outcome === 'ELIGIBLE') {
        try {
          const leadDetail = await client.getLead(row.id);
          const phoneDecision = evaluatePhoneEligibility(leadDetail);
          outcome = phoneDecision.outcome;
          reason = phoneDecision.reason;
          detail = phoneDecision.detail;
        } catch (error) {
          outcome = 'NEEDS_REVIEW';
          reason = 'context_lookup_failed';
          detail =
            error instanceof Error ? error.message.slice(0, 200) : 'lead detail lookup failed';
        }
      }

      summary.byOutcome[outcome] = (summary.byOutcome[outcome] ?? 0) + 1;
      summary.byReason[reason] = (summary.byReason[reason] ?? 0) + 1;

      if (summary.rows.length < maxRowsReported) {
        summary.rows.push({
          leadId: row.id,
          updatedAt: row.updated_at,
          outcome,
          reason,
          ...(detail === undefined ? {} : { detail }),
        });
      }
    }

    if (result.nextCursor === null) break;

    if (result.nextCursor === cursor) {
      summary.warnings.push('nextCursor did not advance; stopped pagination early');
      break;
    }

    cursor = result.nextCursor;

    if (page === maxPages - 1) {
      summary.warnings.push(`stopped at the ${String(maxPages)}-page preview bound`);
    }
  }

  logger.info(
    {
      since: summary.since,
      pages: summary.pagesFetched,
      rows: summary.rowsSeen,
      byOutcome: summary.byOutcome,
      byReason: summary.byReason,
      checkedPhone: checkPhone,
    },
    'eligibility preview complete: nothing was written',
  );

  return summary;
}
