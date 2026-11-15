import 'dotenv/config';
import { z } from 'zod';

/** Parses the common textual spellings of a boolean flag. */
function booleanFlag(defaultValue: 'true' | 'false') {
  return z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(defaultValue)
    .transform((value) => value === 'true' || value === '1' || value === 'yes');
}

/**
 * An optional variable that is absent when unset OR set to an empty string.
 *
 * `.env.example` ships placeholders like `LEAD_API_KEY_CALLER=`, and dotenv
 * loads those as `''`. Plain `.optional()` only covers `undefined`, so an empty
 * placeholder would fail validation and stop the server booting - exactly the
 * opposite of "optional at startup".
 */
function optionalString() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    z.string().min(1).optional(),
  );
}

/** Splits a comma-separated list into trimmed, non-empty entries. */
const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

/**
 * Environment contract for the application.
 *
 * Only variables the service genuinely needs are required. The Lead API
 * credential is optional at startup (Phase 2) so the HTTP server and health
 * endpoints still run without it; the polling service fails clearly and safely
 * when it is missing. Retell and Calendly configuration is documented in
 * `.env.example` as planned and is deliberately NOT validated here.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Bearer key for the authenticated call-history read API (`GET /api/calls*`).
   * Optional: when unset the read API FAILS CLOSED (503) so call transcripts and
   * other call detail are never exposed without a configured credential.
   */
  CALL_READ_API_KEY: optionalString(),

  /**
   * The only supported way to configure the database. Must be a postgres URL;
   * the value itself is never logged.
   */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      'DATABASE_URL must be a PostgreSQL connection string (postgresql://...)',
    ),

  /**
   * Comma-separated browser origin allowlist. Empty means "send no
   * cross-origin access headers", which is the secure default. "*" is rejected.
   */
  CORS_ALLOWED_ORIGINS: commaList
    .default('')
    .refine(
      (origins) => !origins.includes('*'),
      'CORS_ALLOWED_ORIGINS must not contain "*". List explicit origins instead.',
    ),

  // -------------------------------------------------------------------------
  // Lead API (Phase 2) - READ ONLY.
  // -------------------------------------------------------------------------

  /** Funnel host serving `/api/crm/*`. */
  LEAD_API_BASE_URL: z
    .string()
    .url('LEAD_API_BASE_URL must be an absolute URL')
    .default('https://guided-boost.lovable.app')
    .refine(
      (value) => value.startsWith('https://'),
      'LEAD_API_BASE_URL must use https so the API key is never sent in clear text',
    )
    // Normalise away a trailing slash so path joining stays predictable.
    .transform((value) => value.replace(/\/+$/, '')),

  /**
   * Sent as the `X-Lead-API-Key` header. Optional so the server boots without
   * it; `requireLeadApiKey()` is the single place that enforces its presence.
   * Never logged, never included in an error message.
   */
  LEAD_API_KEY_CALLER: optionalString(),

  /** Per-request timeout for Lead API calls. */
  LEAD_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

  /** Retry budget for a single safe GET. 0 disables retries entirely. */
  LEAD_API_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(3),

  /** Page size passed as `limit`. 200 is the documented workflow size. */
  LEAD_API_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(200),

  /** Optional `brand` filter for the incremental lead listing. */
  LEAD_API_BRAND: optionalString(),

  // -------------------------------------------------------------------------
  // Lead polling and eligibility (Phase 2).
  // -------------------------------------------------------------------------

  /** Hard bound on pages fetched per poll run, so a run can never loop forever. */
  LEAD_POLL_MAX_PAGES: z.coerce.number().int().min(1).max(500).default(20),

  /**
   * `since` used on the very first poll, before a durable watermark exists.
   * Leads already present at that point are recorded as known-before-we-started
   * and are never auto-called. Defaults to "now" at first run.
   */
  LEAD_POLL_INITIAL_SINCE: z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    z
      .string()
      .datetime({ message: 'LEAD_POLL_INITIAL_SINCE must be an ISO-8601 UTC timestamp' })
      .optional(),
  ),

  /**
   * MASTER SAFETY SWITCH, default OFF.
   *
   * While false, no lead is ever marked ELIGIBLE automatically: candidates that
   * pass every verified check land in NEEDS_REVIEW instead. It stays off until
   * the new-vs-changed contract (the authoritative creation timestamp) is
   * confirmed with the product owner, so an unverified guess can never put a
   * real customer into a calling queue.
   */
  LEAD_ELIGIBILITY_AUTO_ENABLED: booleanFlag('false'),

  /**
   * Lead statuses that must never receive an initial AI call.
   *
   * Defaults to exactly the three statuses the workflow documentation names:
   * Unsubscribe, Closed, Post Trip. Other statuses observed live but never
   * confirmed as exclusions (Newsletter, Unsubscribe (M), Deleted,
   * Cancelled (NR), Dead Lead) are deliberately NOT included - adding them
   * would be inventing a business rule rather than applying a documented one.
   * Configurable so a confirmed addition is a config change, not a code change.
   */
  LEAD_BLOCKED_STATUSES: commaList.default('Unsubscribe,Closed,Post Trip'),

  // -------------------------------------------------------------------------
  // Calendar / booking (Oct 20 brief).
  // -------------------------------------------------------------------------

  /**
   * TEST SCOPE: the brand code to poll for during the initial test. The Oct 20
   * brief restricts the test to Himalayan Wonders (`brand=HW`). Explicit and
   * configurable so it is clearly a test restriction, not a permanent one — a
   * production rollout widens or clears it.
   */
  LEAD_TEST_BRAND: z.string().min(1).default('HW'),

  /**
   * Fixed caller write identity, sent on every authorised CRM write as
   * `X-Agent-Email` + `X-Agent-Name`. Not secrets (an address + a label); kept
   * in config so they are not hard-coded. Defaults match the brief.
   */
  CRM_AGENT_EMAIL: z.string().min(1).default('ai-caller@himalayanwonders.com'),
  CRM_AGENT_NAME: z.string().min(1).default('AI Caller'),

  // -------------------------------------------------------------------------
  // Retell outbound calling (Phase 3).
  // -------------------------------------------------------------------------

  /**
   * MASTER SWITCH for placing outbound calls, default OFF.
   *
   * Deliberately INDEPENDENT of `LEAD_ELIGIBILITY_AUTO_ENABLED`: a lead becoming
   * ELIGIBLE must never be sufficient to place a call. While this is false, no
   * outbound call may be initiated regardless of eligibility - the enforcement
   * point is `requireRetellCallingEnabled()`, called first inside the Retell
   * client before any network request. It stays off until calling is explicitly
   * approved; the successful manual dashboard test does not authorise it.
   */
  RETELL_CALLING_ENABLED: booleanFlag('false'),

  /**
   * Retell REST API base URL. Verified against the official OpenAPI spec:
   * `POST /v2/create-phone-call` lives under `https://api.retellai.com`.
   * Must be https so the bearer key is never sent in clear text.
   */
  RETELL_API_BASE_URL: z
    .string()
    .url('RETELL_API_BASE_URL must be an absolute URL')
    .default('https://api.retellai.com')
    .refine(
      (value) => value.startsWith('https://'),
      'RETELL_API_BASE_URL must use https so the API key is never sent in clear text',
    )
    .transform((value) => value.replace(/\/+$/, '')),

  /**
   * Bearer credential for the Retell API, sent as `Authorization: Bearer <key>`.
   * Optional at startup (the server boots without it); `requireRetellConfig()`
   * is the single place that enforces its presence. Never logged.
   */
  RETELL_API_KEY: optionalString(),

  /** Registered Retell outbound number (caller ID), E.164. Validated at use. */
  RETELL_FROM_NUMBER: optionalString(),

  /** Id of the configured Retell agent that runs the call (the "Travel Call Agent"). */
  RETELL_AGENT_ID: optionalString(),

  /**
   * Human-readable agent name, informational only. Surfaced in a safe log line
   * so an operator can confirm the right agent is wired up; not sent to the API
   * (the API selects the agent by id, not name).
   */
  RETELL_AGENT_NAME: optionalString(),

  /** Per-request timeout for Retell calls. */
  RETELL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),

  // -------------------------------------------------------------------------
  // Background lead worker (automatic polling).
  // -------------------------------------------------------------------------

  /**
   * Starts the in-process background worker that runs `runLeadPoll()` on a timer,
   * so leads are detected, ingested, classified and (when calling is enabled)
   * handed to the orchestrator WITHOUT a manual `npm run poll:leads`.
   *
   * Default OFF so simply running the HTTP server never starts polling or dialling
   * by surprise. Automatic operation = set this true in the deployment. It is
   * INDEPENDENT of the two safety switches: the worker classifies leads even when
   * calling is disabled, and actual dialling still requires RETELL_CALLING_ENABLED
   * (enforced inside `runLeadPoll`/the orchestrator), while ELIGIBLE classification
   * still requires LEAD_ELIGIBILITY_AUTO_ENABLED.
   */
  LEAD_WORKER_ENABLED: booleanFlag('false'),

  /** Delay between the end of one poll cycle and the start of the next. */
  LEAD_WORKER_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),

  /** Upper bound for the exponential backoff applied after consecutive failures. */
  LEAD_WORKER_MAX_BACKOFF_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(300_000),

  /**
   * When true, each poll cycle is guarded by a Postgres advisory lock so that
   * across multiple replicas only ONE polls at a time (avoids redundant Lead API
   * reads). Duplicate CALLS are already prevented at the DB regardless (the
   * version-guarded claim + the `call_records_active_leadId_key` unique index);
   * this flag only reduces redundant polling. Default OFF (single-process).
   */
  LEAD_WORKER_USE_DB_LOCK: booleanFlag('false'),

  // -------------------------------------------------------------------------
  // Automatic NEEDS_REVIEW re-evaluation (bounded + throttled).
  // -------------------------------------------------------------------------

  /**
   * When true, after each poll cycle the worker also re-evaluates a BOUNDED,
   * THROTTLED batch of leads stuck in NEEDS_REVIEW for a data-availability
   * reason (e.g. the phone verdict had not been populated yet). It reuses the
   * exact same eligibility logic and the version-guarded CAS, never promotes a
   * blocked-status (e.g. Unsubscribe) lead, and still gates dialling on
   * RETELL_CALLING_ENABLED. Default OFF: no lead is ever automatically
   * re-evaluated unless this is explicitly enabled.
   */
  LEAD_REEVAL_ENABLED: booleanFlag('false'),

  /**
   * Base delay before a NEEDS_REVIEW lead is retried, measured from when it was
   * decided. Chosen to comfortably clear the Lead API's async phone-validation
   * lag (observed ~7-10 min), so the default is 10 minutes. Each further attempt
   * waits this × backoff^attempt.
   */
  LEAD_REEVAL_RETRY_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(600_000),

  /** Multiplier applied to the retry interval after each unsuccessful attempt. */
  LEAD_REEVAL_BACKOFF_FACTOR: z.coerce.number().int().min(1).max(10).default(2),

  /** Hard cap on retries per lead; after this it is left NEEDS_REVIEW (exhausted). */
  LEAD_REEVAL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  /** Max Lead API re-evaluations performed in a single sweep (bounds API load). */
  LEAD_REEVAL_MAX_PER_CYCLE: z.coerce.number().int().min(1).max(100).default(10),

  /** Max NEEDS_REVIEW rows read from the local DB per sweep to consider. */
  LEAD_REEVAL_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),

  // -------------------------------------------------------------------------
  // No-answer call retry (persistent, hold-aware). COMPLETELY SEPARATE from the
  // NEEDS_REVIEW re-evaluation above: this re-DIALS a lead whose call was not
  // answered, it does not re-evaluate eligibility data.
  // -------------------------------------------------------------------------

  /**
   * When true, after each poll cycle the worker also runs the no-answer retry
   * sweep: a lead whose call ended NO_ANSWER is re-dialled (subject to an active
   * caller hold) up to LEAD_RETRY_MAX_ATTEMPTS total attempts. Default OFF: no
   * lead is ever retried unless this is explicitly enabled. Dialling still also
   * requires RETELL_CALLING_ENABLED.
   */
  LEAD_RETRY_ENABLED: booleanFlag('false'),

  /** Total call attempts allowed per lead, INCLUDING the first call (so 5 = first + 4 retries). */
  LEAD_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

  /** Delay after a NO_ANSWER before the next attempt is due. Default 5 minutes. */
  LEAD_RETRY_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),

  /**
   * How long to wait before re-checking a retry whose caller hold was not active
   * when it came due (waiting for the CRM to re-issue a hold). Default 5 minutes.
   */
  LEAD_RETRY_RECHECK_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),

  /**
   * Maximum total time to keep waiting for a valid caller hold, measured from the
   * last actual dial. After this elapses with no hold, the lead moves to
   * NEEDS_REVIEW (reason `retry_hold_unavailable`) so the RM is notified — it is
   * NOT silently completed. Default 24 hours.
   */
  LEAD_RETRY_MAX_WAIT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(604_800_000)
    .default(86_400_000),

  /** Max retries attempted in a single sweep (bounds Lead API + Retell load). */
  LEAD_RETRY_MAX_PER_CYCLE: z.coerce.number().int().min(1).max(100).default(10),

  /** Max RETRY_PENDING rows read from the local DB per sweep to consider. */
  LEAD_RETRY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),

  // -------------------------------------------------------------------------
  // Reconciliation sweeps (recover leads/notes stranded by crashes, missing
  // webhooks, or transient failures). Default OFF; dialling still requires
  // RETELL_CALLING_ENABLED, so enabling this never places a call on its own.
  // -------------------------------------------------------------------------

  /** Master switch for the stuck-state + ELIGIBLE-backstop + note redelivery sweeps. */
  LEAD_RECONCILE_ENABLED: booleanFlag('false'),

  /**
   * A lead stuck in CALLING longer than this is reconciled to NEEDS_REVIEW
   * (`call_unreconciled`) — a safe fallback that never claims the call completed
   * and never auto-redials (the call may have connected). Default 30 minutes.
   */
  LEAD_STUCK_CALLING_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),

  /**
   * A lead stuck in PROCESSING (claimed, crashed before it dialled) longer than
   * this is returned to ELIGIBLE for another safe attempt. No call was placed in
   * PROCESSING, so this cannot double-dial. Default 10 minutes.
   */
  LEAD_STUCK_PROCESSING_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(600_000),

  /**
   * A lead left ELIGIBLE but not called (e.g. a transient lead_unavailable at dial
   * time, or a crash mid-retry) for longer than this is re-handed to the
   * orchestrator — the authoritative gates (hold, CRM, phone, claim) still apply.
   * Default 5 minutes, so the poll's inline call attempt runs first.
   */
  LEAD_ELIGIBLE_BACKSTOP_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),

  /** Max reconciliation actions per sweep (bounds API/DB load). */
  LEAD_RECONCILE_MAX_PER_CYCLE: z.coerce.number().int().min(1).max(200).default(20),

  /** Max rows read from the local DB per reconciliation sweep. */
  LEAD_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),

  /** Hard cap on CRM note delivery attempts before the note is left failed. */
  LEAD_NOTE_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  /** Minimum delay between CRM note delivery attempts. Default 5 minutes. */
  LEAD_NOTE_RETRY_BACKOFF_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),

  // -------------------------------------------------------------------------
  // Guided Boost queue hand-off (`GET /api/caller/queue` + status reporting).
  // Additive foundation only — no worker/client/call-flow wired yet. Default
  // OFF, and dialling still requires RETELL_CALLING_ENABLED, so these flags
  // alone never poll a queue or place a call.
  // -------------------------------------------------------------------------

  /**
   * MASTER SWITCH for the Guided Boost queue worker, default OFF. While false,
   * no queue is polled and no queue lead is ingested. Independent of
   * LEAD_WORKER_ENABLED (the poll worker) so the two sources enable separately.
   */
  CALLER_QUEUE_ENABLED: booleanFlag('false'),

  /** Delay between queue poll cycles. Default 30s (the documented cadence). */
  CALLER_QUEUE_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(3_600_000)
    .default(30_000),

  /**
   * How long before a queue lead's `call_before` deadline the one-time
   * `call_in_progress` extension signal is sent. Default 60s.
   */
  CALLER_IN_PROGRESS_LEAD_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(60_000),

  /**
   * Base URL for the Guided Boost caller queue + status endpoints. Defaults to
   * the same host as the Lead API, since the endpoints live alongside `/api/crm/*`.
   * Reuses the existing LEAD_API_KEY_CALLER / CRM_AGENT_EMAIL / CRM_AGENT_NAME
   * auth — no separate queue credential is introduced.
   */
  CALLER_QUEUE_BASE_URL: z
    .string()
    .url('CALLER_QUEUE_BASE_URL must be an absolute URL')
    .default('https://guided-boost.lovable.app')
    .refine(
      (value) => value.startsWith('https://'),
      'CALLER_QUEUE_BASE_URL must use https so the API key is never sent in clear text',
    )
    .transform((value) => value.replace(/\/+$/, '')),

  /**
   * MASTER SWITCH for the QUEUE final-status RECONCILIATION sweep, default OFF.
   *
   * When off, a failed Guided Boost final-status report stays `failed` in the DB
   * (recoverable) but is never automatically re-sent, and no new status requests
   * are issued. Independent of the queue worker and the poll reconciliation. The
   * sweep ONLY re-sends the already-persisted final status — it can never place a
   * call, re-evaluate a lead, or touch the Step 5 source guards.
   */
  CALLER_STATUS_RECONCILE_ENABLED: booleanFlag('false'),

  /**
   * MASTER SWITCH for the active-call deadline monitor, default OFF.
   *
   * When off, no `call_in_progress` is ever sent and no deadline extension is
   * requested. When on, the queue worker's post-poll sweep sends ONE
   * `call_in_progress` per QUEUE call as it nears `callBeforeAt`, and persists any
   * extended `call_before` Guided Boost returns. The monitor can never place a call
   * or re-evaluate a lead; Guided Boost remains the owner of the eventual timeout.
   */
  CALLER_DEADLINE_MONITOR_ENABLED: booleanFlag('false'),

  /**
   * Bounded wait after a terminal QUEUE call before its final status is sent, so
   * late Retell artifacts (transcript/recording/summary, which arrive on
   * `call_analyzed` AFTER `call_ended`) can be included. Applies to COMPLETED calls
   * only; non-conversation terminals are finalized on the next sweep. The wait is
   * durable (persisted deadline + sweep), never an in-request sleep. Default 2 min.
   */
  CALLER_FINALIZE_WAIT_MS: z.coerce.number().int().min(0).max(1_800_000).default(120_000),

  /** Total final-status delivery attempts allowed per lead (incl. the first). */
  CALLER_STATUS_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  /** Minimum delay between final-status delivery attempts. Default 5 minutes. */
  CALLER_STATUS_RETRY_BACKOFF_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(300_000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses an environment-like object. Exported for tests; application code
 * should use the `env` singleton below.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    // Values are intentionally omitted so a bad DATABASE_URL or API key is
    // never echoed into a log or a crash report.
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}

export const env: Env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Returns the Lead API key, or throws a message that names the missing variable
 * without revealing anything about its value.
 *
 * This is the single enforcement point: the server boots happily without a key,
 * but any attempt to actually reach the Lead API fails loudly here first.
 */
export function requireLeadApiKey(source: Env = env): string {
  const key = source.LEAD_API_KEY_CALLER;

  if (!key) {
    throw new Error(
      'LEAD_API_KEY_CALLER is not configured. Set it in .env before running lead polling.',
    );
  }

  return key;
}

/**
 * Single enforcement point for the outbound-calling master switch.
 *
 * Throws (never returns false) when calling is disabled, so a future call path
 * fails closed and loudly rather than silently skipping the guard. No real call
 * can be placed while `RETELL_CALLING_ENABLED` is false.
 */
export function requireRetellCallingEnabled(source: Env = env): void {
  if (!source.RETELL_CALLING_ENABLED) {
    throw new Error(
      'RETELL_CALLING_ENABLED is false; outbound calling is disabled. No call was placed.',
    );
  }
}

/**
 * Returns the Retell API key, or throws a value-free error if it is missing.
 *
 * This is the secret used to VERIFY inbound webhook signatures: Retell signs
 * webhooks with your API key (confirmed from the official SDK v6.2.6 —
 * `verify(body, apiKey, signature)`), so there is no separate webhook secret.
 * It is a narrower guard than `requireRetellConfig()` because verifying a
 * webhook needs only the key, not the from-number or agent id.
 */
export function requireRetellApiKey(source: Env = env): string {
  if (!source.RETELL_API_KEY) {
    throw new Error('RETELL_API_KEY is not configured; cannot verify Retell webhook signatures.');
  }
  return source.RETELL_API_KEY;
}

/** The Retell credentials/config needed to place a call. */
export interface RetellConfig {
  baseUrl: string;
  apiKey: string;
  fromNumber: string;
  agentId: string;
  agentName?: string;
  timeoutMs: number;
}

/** E.164: a leading '+', a non-zero country digit, then 6-14 more digits. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Resolves the Retell configuration, or throws an error that names the missing
 * or malformed variables WITHOUT revealing any value.
 *
 * Enforcement is separate from `requireRetellCallingEnabled()` on purpose: the
 * switch can be on while config is incomplete, and vice versa, and each failure
 * should read clearly. The client calls the switch guard first, then this.
 */
export function requireRetellConfig(source: Env = env): RetellConfig {
  const missing: string[] = [];
  if (!source.RETELL_API_KEY) missing.push('RETELL_API_KEY');
  if (!source.RETELL_FROM_NUMBER) missing.push('RETELL_FROM_NUMBER');
  if (!source.RETELL_AGENT_ID) missing.push('RETELL_AGENT_ID');

  if (missing.length > 0) {
    throw new Error(
      `Retell configuration incomplete: ${missing.join(', ')} not set. Add them in .env before calling.`,
    );
  }

  // Names are safe to echo; the number itself is caller ID, not a secret, but we
  // still only report the variable name on failure.
  if (!E164.test(source.RETELL_FROM_NUMBER!)) {
    throw new Error('RETELL_FROM_NUMBER must be a valid E.164 number (e.g. +19789538571).');
  }

  return {
    baseUrl: source.RETELL_API_BASE_URL,
    apiKey: source.RETELL_API_KEY!,
    fromNumber: source.RETELL_FROM_NUMBER!,
    agentId: source.RETELL_AGENT_ID!,
    ...(source.RETELL_AGENT_NAME === undefined ? {} : { agentName: source.RETELL_AGENT_NAME }),
    timeoutMs: source.RETELL_TIMEOUT_MS,
  };
}
