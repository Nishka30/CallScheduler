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
