/**
 * Controlled single-lead re-evaluation — ONE lead id, explicit, nothing automatic.
 *
 * Use this when a lead is stuck in NEEDS_REVIEW for a reason that was a DATA
 * gap at the time (e.g. `phone_verdict_unreadable` because the Lead API's phone
 * verdict object had not been created yet) and you want to check whether it has
 * since resolved. It never touches any other lead and never resets a decision
 * that was already final (ELIGIBLE/SKIPPED/PENDING/etc are left exactly alone).
 *
 *   npx tsx src/scripts/reevaluateLead.ts <leadId>
 *   npm run reevaluate:lead -- <leadId>
 *
 * SAFETY — identical gating to the rest of this project:
 *   - If the fresh check still can't decide, or decides SKIPPED (e.g. the lead
 *     is now Unsubscribed), the lead is updated accordingly and NO call happens.
 *   - If the fresh check decides ELIGIBLE, a call is attempted ONLY when
 *     RETELL_CALLING_ENABLED is true - exactly like the automatic poll path.
 *   - This is deliberately NOT wired into the background worker: it is run by a
 *     human, for one lead id, on purpose.
 */
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { disconnectPrisma } from '../lib/prisma.js';
import { reevaluateNeedsReviewLead } from '../services/leadReevaluation.service.js';

async function main(): Promise<void> {
  const leadId = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

  if (!leadId) {
    logger.fatal(
      'usage: tsx src/scripts/reevaluateLead.ts <leadId>  (exactly one lead id required)',
    );
    process.exitCode = 1;
    return;
  }

  if (!env.LEAD_API_KEY_CALLER) {
    logger.fatal('LEAD_API_KEY_CALLER is not configured; cannot fetch fresh lead detail');
    process.exitCode = 1;
    return;
  }

  logger.info(
    { leadId, callingEnabled: env.RETELL_CALLING_ENABLED },
    'lead re-evaluation: starting',
  );

  const result = await reevaluateNeedsReviewLead(leadId);

  // Outcome + reasons only - never a phone number, name or email.
  logger.info(result, 'lead re-evaluation: finished');
}

main()
  .catch((error: unknown) => {
    logger.fatal(
      { err: error instanceof Error ? { name: error.name, message: error.message } : undefined },
      'lead re-evaluation failed',
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });
