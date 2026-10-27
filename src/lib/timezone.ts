/**
 * Timezone normalisation for the booking flow.
 *
 * Retell's agent LLM supplies the customer timezone as free text, which is not
 * always a valid IANA identifier. The CRM team-slots API only accepts IANA
 * NAMES: `Asia/Kolkata` returns 200, but `India Standard Time`, `GMT+5:30` and
 * `invalid-zone` all return 400. So we normalise to a canonical IANA id BEFORE
 * calling the CRM, and return a safe fallback (`null`) for anything we cannot
 * justify — the caller then asks the customer to restate it rather than guessing.
 *
 * Note: the runtime's `Intl` accepts bare offset zones like `+05:30`, but the
 * CRM may not, so offset and alias spellings are always converted to an IANA
 * NAME before any `Intl` pass-through. `starts_at` values are UTC instants and
 * are never affected by this — only the zone used for availability + the spoken
 * local time is normalised.
 */

/** True when the runtime's ICU recognises `tz` as a usable time zone. */
export function isValidIanaTimeZone(tz: string): boolean {
  try {
    // Throws RangeError for an unknown zone; accepts any id ICU knows.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Named aliases → canonical IANA. Keys are normalised (lower-case, single
 * spaces). Ambiguous abbreviations resolve to the most likely zone for this
 * India-centric travel audience; anything not listed falls back safely rather
 * than being mis-mapped.
 */
const TZ_ALIASES: Readonly<Record<string, string>> = {
  // India / subcontinent
  'india standard time': 'Asia/Kolkata',
  'indian standard time': 'Asia/Kolkata',
  ist: 'Asia/Kolkata',
  kolkata: 'Asia/Kolkata',
  calcutta: 'Asia/Kolkata',
  'new delhi': 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata',
  bengaluru: 'Asia/Kolkata',
  bangalore: 'Asia/Kolkata',
  'nepal time': 'Asia/Kathmandu',
  npt: 'Asia/Kathmandu',
  kathmandu: 'Asia/Kathmandu',
  'pakistan standard time': 'Asia/Karachi',
  pkt: 'Asia/Karachi',
  'bangladesh standard time': 'Asia/Dhaka',
  // Middle East
  'gulf standard time': 'Asia/Dubai',
  gst: 'Asia/Dubai',
  dubai: 'Asia/Dubai',
  // UK / Europe
  'gmt standard time': 'Europe/London',
  'greenwich mean time': 'Europe/London',
  'british summer time': 'Europe/London',
  bst: 'Europe/London',
  london: 'Europe/London',
  'central european time': 'Europe/Paris',
  cet: 'Europe/Paris',
  cest: 'Europe/Paris',
  // North America
  'eastern standard time': 'America/New_York',
  'eastern time': 'America/New_York',
  et: 'America/New_York',
  est: 'America/New_York',
  edt: 'America/New_York',
  'central standard time': 'America/Chicago',
  'central time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'mountain time': 'America/Denver',
  mst: 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'pacific time': 'America/Los_Angeles',
  pt: 'America/Los_Angeles',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  // Asia-Pacific
  'singapore standard time': 'Asia/Singapore',
  sgt: 'Asia/Singapore',
  singapore: 'Asia/Singapore',
  'australian eastern standard time': 'Australia/Sydney',
  aest: 'Australia/Sydney',
  aedt: 'Australia/Sydney',
  sydney: 'Australia/Sydney',
};

/**
 * Half-hour / quarter-hour offsets → their one canonical IANA zone. Whole-hour
 * offsets are handled generically via `Etc/GMT±N`; these cannot be expressed as
 * `Etc/GMT` zones, so each maps to its representative region.
 */
const FRACTIONAL_OFFSET_ZONES: Readonly<Record<string, string>> = {
  '+3:30': 'Asia/Tehran',
  '+4:30': 'Asia/Kabul',
  '+5:30': 'Asia/Kolkata',
  '+5:45': 'Asia/Kathmandu',
  '+6:30': 'Asia/Yangon',
  '+9:30': 'Australia/Darwin',
  '+10:30': 'Australia/Lord_Howe',
  '+8:45': 'Australia/Eucla',
  '+12:45': 'Pacific/Chatham',
  '-3:30': 'America/St_Johns',
};

/**
 * Converts a `GMT±H[:MM]` / `UTC±H[:MM]` / `±HH[:MM]` spelling to an IANA zone,
 * or null when there is no canonical zone for that offset.
 */
function offsetToIana(key: string): string | null {
  const m = /^(?:gmt|utc)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(key);
  if (!m) return null;
  const sign = m[1];
  const hours = Number(m[2]);
  const minutes = m[3] === undefined ? 0 : Number(m[3]);
  if (hours > 14 || minutes > 59) return null;

  if (minutes !== 0) {
    const norm = `${sign}${String(hours)}:${String(minutes).padStart(2, '0')}`;
    return FRACTIONAL_OFFSET_ZONES[norm] ?? null;
  }
  if (hours === 0) return 'UTC';
  // IANA `Etc/GMT` zones invert the sign: UTC+5 ⇒ Etc/GMT-5.
  const invSign = sign === '+' ? '-' : '+';
  return `Etc/GMT${invSign}${String(hours)}`;
}

/**
 * Normalises a caller-supplied timezone into a canonical IANA id the CRM
 * team-slots API accepts, or null when it cannot be understood.
 *
 * Order: (1) a known named alias; (2) a GMT/UTC/±offset spelling; (3) a value
 * the runtime already recognises as a valid IANA id, passed through. Alias and
 * offset forms are tried before the pass-through so an offset `Intl` would accept
 * (e.g. `+05:30`) is still converted to an IANA NAME the CRM accepts. Anything
 * else returns null. Every non-null result is re-validated against `Intl`.
 */
export function normalizeTimezone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const candidate =
    TZ_ALIASES[key] ?? offsetToIana(key) ?? (isValidIanaTimeZone(trimmed) ? trimmed : null);

  return candidate !== null && isValidIanaTimeZone(candidate) ? candidate : null;
}
