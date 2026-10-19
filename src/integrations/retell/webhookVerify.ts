import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Retell webhook signature.
 *
 * This is a faithful reimplementation of the official Retell SDK's
 * `symmetric.verify` (retell-sdk v6.2.6, `lib/webhook_auth.js`), confirmed by
 * reading the published package source rather than guessing:
 *
 *   - The `x-retell-signature` header has the form `v=<timestamp>,d=<hexdigest>`.
 *   - The digest is HMAC-SHA256, hex-encoded (64 chars), keyed by the Retell
 *     **API key** (there is no separate webhook secret), over the string
 *     `<rawBody><timestamp>` — the exact raw request body concatenated with the
 *     timestamp from the header.
 *   - There is a built-in replay window: the header timestamp must be within
 *     `timeoutMs` (default 5 minutes) of now.
 *   - Comparison is constant-time.
 *
 * Fails closed: any parse failure, a bad digest length, a stale timestamp, or a
 * mismatch returns `false`. The raw body MUST be the exact bytes Retell sent —
 * re-serialised JSON will not verify.
 */
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const SHA256_HEX_LENGTH = 64;
const SIGNATURE_FORMAT = /^v=(\d+),d=([0-9a-f]+)$/i;

export interface VerifyOptions {
  /** Injected for tests; defaults to Date.now(). */
  now?: number;
  /** Replay window in ms; defaults to 5 minutes (the SDK default). */
  timeoutMs?: number;
}

export function verifyRetellSignature(
  rawBody: string,
  apiKey: string,
  signature: string,
  options: VerifyOptions = {},
): boolean {
  if (!apiKey || !signature) return false;

  const match = SIGNATURE_FORMAT.exec(signature);
  if (!match) return false;

  const poststamp = Number(match[1]);
  const digestHex = match[2]!.toLowerCase();

  if (digestHex.length !== SHA256_HEX_LENGTH) return false;

  const now = options.now ?? Date.now();
  const timeout = options.timeoutMs ?? FIVE_MINUTES_MS;

  if (
    !Number.isSafeInteger(poststamp) ||
    !Number.isFinite(now) ||
    timeout < 0 ||
    Math.abs(now - poststamp) > timeout
  ) {
    return false;
  }

  // Keyed by the API key, over rawBody + the timestamp (as the SDK does).
  const expectedHex = createHmac('sha256', apiKey)
    .update(rawBody + String(poststamp))
    .digest('hex');

  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(digestHex, 'hex');

  // Length guard before timingSafeEqual (it throws on mismatched lengths).
  if (expected.length !== provided.length) return false;

  return timingSafeEqual(expected, provided);
}
