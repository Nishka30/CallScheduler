/**
 * Controlled, manual lead-poll runner.
 *
 * Deliberately a local command rather than an HTTP endpoint: the service has no
 * authentication layer yet, and an unauthenticated route that reaches a real
 * CRM would be the wrong thing to expose. Running it requires shell access to
 * the deployment, which is the authorization mechanism until Phase 6 adds a
 * real one.
 *
 *   npm run poll:leads:dry                     probe response shape, write nothing
 *   npm run poll:leads:preview                 show which leads would be considered
 *                                               new/eligible, write nothing - no database
 *                                               required
 *   npm run poll:leads -- --preview --since=2026-10-13T00:00:00Z --check-phone --max-pages=3
 *   npm run poll:leads                         read, decide, and persist decisions
 *   npm run poll:leads -- --no-context         same, but skip detail/history lookups
 *
 * It never places a call and never writes to the CRM. Only the plain
 * `npm run poll:leads` form (no --dry-run / --preview) writes to our own
 * database, and only after eligibility has been decided.
 */
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { disconnectPrisma } from '../lib/prisma.js';
import { LeadApiClient } from '../integrations/leadApi/client.js';
import { runLeadPoll } from '../services/leadPolling.service.js';
import { previewLeadEligibility } from '../services/leadEligibilityPreview.service.js';

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

/** Parses `--name=value` from argv; returns undefined when absent. */
function namedArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

const DEFAULT_PREVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const dryRun = hasFlag('--dry-run');
  const preview = hasFlag('--preview');
  const skipContext = hasFlag('--no-context');
  const checkPhone = hasFlag('--check-phone');

  if (!env.LEAD_API_KEY_CALLER) {
    // Named, never valued.
    logger.fatal('LEAD_API_KEY_CALLER is not configured; cannot poll the Lead API');
    process.exitCode = 1;
    return;
  }

  logger.info(
    {
      baseUrl: env.LEAD_API_BASE_URL,
      mode: preview ? 'preview' : dryRun ? 'dry-run' : 'full',
      autoEligibility: env.LEAD_ELIGIBILITY_AUTO_ENABLED,
      pageSize: env.LEAD_API_PAGE_SIZE,
    },
    'starting manual lead poll',
  );

  if (preview) {
    // Full eligibility evaluation against live data - no database required,
    // nothing written anywhere. This is what answers "which leads would be
    // considered new" (Decision 2) without enabling automatic processing.
    const since =
      namedArg('since') ?? new Date(Date.now() - DEFAULT_PREVIEW_WINDOW_MS).toISOString();
    const maxPagesArg = namedArg('max-pages');
    const maxPages = maxPagesArg ? Number.parseInt(maxPagesArg, 10) : undefined;

    const summary = await previewLeadEligibility({
      since,
      checkPhone,
      ...(maxPages !== undefined && Number.isFinite(maxPages) ? { maxPages } : {}),
    });

    for (const warning of summary.warnings) {
      logger.warn(warning);
    }

    logger.info(
      {
        since: summary.since,
        pagesFetched: summary.pagesFetched,
        rowsSeen: summary.rowsSeen,
        byOutcome: summary.byOutcome,
        byReason: summary.byReason,
        // Newsletter is NOT blocked (never confirmed as an exclusion), so this
        // is the only thing that makes such a record visible instead of
        // disappearing into the undifferentiated pending pile.
        newsletterCandidateCount: summary.newsletterCandidateCount,
        checkedPhone: summary.checkedPhone,
      },
      'eligibility preview summary (nothing written)',
    );

    // Lead ids, decision reasons, and review flags only - never a name, phone
    // or email.
    for (const row of summary.rows) {
      logger.info(
        {
          leadId: row.leadId,
          updatedAt: row.updatedAt,
          outcome: row.outcome,
          reason: row.reason,
          ...(row.flags && row.flags.length > 0 ? { flags: row.flags } : {}),
        },
        'preview decision',
      );
    }
    return;
  }

  if (dryRun) {
    // A dry run proves connectivity and contract shape without touching our
    // database: one page is fetched and nothing is recorded or evaluated.
    const client = new LeadApiClient();
    const page = await client.listLeads({
      since: env.LEAD_POLL_INITIAL_SINCE ?? new Date(Date.now() - 86_400_000).toISOString(),
      limit: Math.min(env.LEAD_API_PAGE_SIZE, 10),
      brand: env.LEAD_API_BRAND ?? env.LEAD_TEST_BRAND,
    });

    logger.info(
      {
        rows: page.rows.length,
        rowsKey: page.rowsKey,
        hasNextCursor: page.nextCursor !== null,
        nextCursorAbsent: page.nextCursorAbsent,
        // Column NAMES only - never values, which are personal data.
        columns: page.rows[0] ? Object.keys(page.rows[0]).sort() : [],
      },
      'dry run complete: nothing was written',
    );
    return;
  }

  const summary = await runLeadPoll({ fetchContext: !skipContext });

  logger.info(summary, 'manual lead poll complete');
}

main()
  .catch((error: unknown) => {
    logger.fatal(
      { err: error instanceof Error ? { name: error.name, message: error.message } : undefined },
      'manual lead poll failed',
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });
