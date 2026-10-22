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
