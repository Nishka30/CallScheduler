/**
 * Controlled single-lead call runner — ONE lead id, nothing else.
 *
 * This is the authorized way to run the Oct 20 controlled test: it calls the
 * orchestrator for exactly the lead id you pass and never touches the general
 * polling process, the CRM, or any other lead.
 *
 *   npx tsx src/scripts/callOneLead.ts <leadId>
 *   npm run call:lead -- <leadId>
 *
 * SAFETY — this script places a call ONLY when every guard already allows it:
 *   - `initiateCallForLead` checks `RETELL_CALLING_ENABLED` first and returns
 *     `calling_disabled` (doing nothing external, nothing in the DB) while the
 *     switch is false. Running this with the switch off is therefore a safe
 *     dry-run that proves the wiring without dialling.
 *   - Even with the switch on, the orchestrator re-fetches the lead and enforces
 *     eligibility, the CRM gate, a VALIDATED E.164 number, and an ACTIVE caller
 *     hold before it dials. An expired hold → `rejected_hold_expired`, no call.
 *
 * It never enables a switch, never books an appointment, and never writes to the
 * CRM. All state stays in the local `ai_caller` database.
 */
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { disconnectPrisma } from '../lib/prisma.js';
import { initiateCallForLead } from '../services/callOrchestrator.service.js';

async function main(): Promise<void> {
  const leadId = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

  if (!leadId) {
    logger.fatal('usage: tsx src/scripts/callOneLead.ts <leadId>  (exactly one lead id required)');
    process.exitCode = 1;
    return;
  }

  logger.info(
    {
      leadId,
      callingEnabled: env.RETELL_CALLING_ENABLED,
      agentName: env.RETELL_AGENT_NAME,
      baseUrl: env.RETELL_API_BASE_URL,
    },
    env.RETELL_CALLING_ENABLED
      ? 'single-lead call: calling ENABLED — guards will still gate the dial'
      : 'single-lead call: calling disabled — this is a safe dry-run, no call will be placed',
  );

  const result = await initiateCallForLead(leadId);

  // Outcome + opaque ids only; never a phone number, name or email.
  logger.info(
    {
      leadId: result.leadId,
      outcome: result.outcome,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.callRecordId === undefined ? {} : { callRecordId: result.callRecordId }),
      ...(result.retellCallId === undefined ? {} : { retellCallId: result.retellCallId }),
    },
    'single-lead call: finished',
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal(
      { err: error instanceof Error ? { name: error.name, message: error.message } : undefined },
      'single-lead call failed',
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });
