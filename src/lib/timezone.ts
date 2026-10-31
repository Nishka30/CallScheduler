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

/**
 * A natural, customer-facing label for a validated IANA zone — e.g.
 * `America/Denver` → "Mountain Time", `Asia/Kolkata` → "India Standard Time".
 *
 * Uses `Intl`'s DST-independent generic name (so it never flips to
 * "…Daylight Time"). Deliberately NEVER returns a raw GMT/UTC offset to the
 * customer: for offset-only zones (`Etc/GMT±N`) where the city is unknown we
 * return a neutral phrase (the agent should confirm the customer's city), and for
 * any other zone whose generic name is offset-like we fall back to the humanized
 * IANA city segment. Falls back safely for an unknown/invalid input.
 */
export function timezoneLabel(tz: string): string {
  if (!isValidIanaTimeZone(tz)) return 'your local time';
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';

  let generic: string | undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longGeneric',
    }).formatToParts(new Date());
    generic = parts.find((p) => p.type === 'timeZoneName')?.value;
  } catch {
    generic = undefined;
  }

  // A good label has a name, not an offset like "GMT-05:00".
  if (generic && !/GMT|UTC|[+-]\d/.test(generic)) return generic;

  // Offset-only zone with no known city: don't speak an offset.
  if (tz.startsWith('Etc/')) return 'your local time';

  // Otherwise humanize the city segment (e.g. "Asia/Kathmandu" → "Kathmandu").
  return humanizeZoneCity(tz) ?? 'your local time';
}

function humanizeZoneCity(tz: string): string | undefined {
  const segment = tz.split('/').pop();
  if (!segment) return undefined;
  const cleaned = segment.replace(/_/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Milliseconds a zone is ahead of UTC at a given instant (handles DST). */
function tzOffsetMs(tz: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p['year']),
    Number(p['month']) - 1,
    Number(p['day']),
    Number(p['hour']),
    Number(p['minute']),
    Number(p['second']),
  );
  return asUtc - instant.getTime();
}

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * UTC instant of local midnight for a `YYYY-MM-DD` calendar date in `tz`.
 * Computes the zone offset AT that instant, so daylight-saving transitions are
 * handled correctly (a local day is not always 24h). Null for a bad date/zone.
 */
function zonedDayStartUtc(localDate: string, tz: string): Date | null {
  if (!LOCAL_DATE_RE.test(localDate) || !isValidIanaTimeZone(tz)) return null;
  const y = Number(localDate.slice(0, 4));
  const mo = Number(localDate.slice(5, 7));
  const d = Number(localDate.slice(8, 10));
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  if (Number.isNaN(guess)) return null;
  const offset = tzOffsetMs(tz, new Date(guess));
  return new Date(guess - offset);
}

/**
 * The UTC window [start-of-local-day, start-of-next-local-day) for a calendar
 * date in the customer's confirmed zone, as ISO strings for the CRM `from`/`to`.
 *
 * `to` is the start of the NEXT local day, which correctly spans a 23h/25h DST
 * day. We treat it as an exclusive-style upper bound; consultation slots never
 * fall on local midnight, so inclusive-vs-exclusive at the boundary is moot in
 * practice (verified against the live CRM, which returned only the requested
 * local day's slots for this exact window).
 */
export function zonedDateRangeUtc(
  localDate: string,
  tz: string,
): { from: string; to: string } | null {
  const start = zonedDayStartUtc(localDate, tz);
  if (!start) return null;
  const y = Number(localDate.slice(0, 4));
  const mo = Number(localDate.slice(5, 7));
  const d = Number(localDate.slice(8, 10));
  const nextLocal = new Date(Date.UTC(y, mo - 1, d + 1, 0, 0, 0));
  const nextDate = `${String(nextLocal.getUTCFullYear())}-${pad2(nextLocal.getUTCMonth() + 1)}-${pad2(nextLocal.getUTCDate())}`;
  const end = zonedDayStartUtc(nextDate, tz);
  if (!end) return null;
  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * Formats a UTC instant as a human local time in `tz`, with NO offset suffix —
 * e.g. "Thu, 5 Nov 2026, 5:00 AM". DST-correct. Undefined for bad input.
 */
export function formatSlotLocal(utcIso: string, tz: string): string | undefined {
  const at = new Date(utcIso);
  if (Number.isNaN(at.getTime()) || !isValidIanaTimeZone(tz)) return undefined;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
