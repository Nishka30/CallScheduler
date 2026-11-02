import type { LeadCallContext } from '../../services/leadContext.service.js';
import {
  formatClockLabel,
  normalizeTimezone,
  timezoneForRegion,
  timezoneLabel,
} from '../../lib/timezone.js';

/**
 * Maps our normalized lead context onto the Travel Call Agent's dynamic
 * variables, so the agent opens grounded in the destination and trip details the
 * lead actually submitted.
 *
 * Returned keys (all `snake_case`, as Retell's `retell_llm_dynamic_variables`
 * requires; braces are added by the prompt, not here):
 *
 *   customer_name         the lead's name (for the greeting)
 *   brand_name            the brand they enquired through
 *   enquired_destination  the destination the enquiry was for (from the funnel page)
 *   preferred_trek        the specific trek/region they chose (confirm_trek)
 *   trip_duration         how long they have (trip_length)
 *   group_size            how many are travelling (group_size)
 *   travel_experience     their stated trekking/hiking experience
 *   travel_timing         when they want to travel (timing)
 *   special_requirements  their own free-text requirements/questions
 *   customer_timezone        a suggested IANA timezone, normalized (an initial hint)
 *   customer_timezone_label  a human-readable label for it (e.g. "Mountain Time")
 *   customer_timezone_source where the suggestion came from: "browser" or "phone"
 *   customer_local_time      the current local time in that zone (e.g. "3:00 PM")
 *
 * Timezone resolution priority (see `resolveTimezoneHint`):
 *   1. the CRM browser timezone (`context.customerTz`) when it normalizes;
 *   2. otherwise a RELIABLE phone-derived zone (the validated number's region maps
 *      to exactly one IANA zone); a multi-zone region is ambiguous and is skipped;
 *   3. otherwise nothing is emitted and the agent asks the customer.
 *
 * The timezone variables are an INITIAL HINT only: the agent confirms (or
 * corrects) the timezone with the customer, and the customer-confirmed value
 * remains the one passed to availability/booking and persisted by the booking
 * flow. A value that does not normalize to a valid IANA id is never sent.
 *
 * Safety rules:
 *   - OMISSION over invention: a key is included only when we have a real,
 *     non-blank value, so the agent never receives an empty or made-up detail.
 *     Defaults for absent variables belong in the Retell prompt, not here.
 *   - These are the SUBMITTED enquiry only. Nothing the customer says on the call
 *     is represented here; the prompt keeps the two distinct.
 *   - No secrets and no unnecessary personal data: phone, email, WhatsApp,
 *     attribution ids and raw payloads are deliberately never mapped. The name is
 *     the only personal field, and only because the agent must greet the lead.
 *
 * All values are strings. Returns `{}` when nothing is available, and the caller
 * then omits `retell_llm_dynamic_variables` entirely.
 */
export function buildAgentDynamicVariables(
  context: LeadCallContext,
  options: { now?: Date } = {},
): Record<string, string> {
  const vars: Record<string, string> = {};

  const put = (key: string, value: string | undefined): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length > 0) vars[key] = trimmed;
  };

  put('customer_name', context.customerName);
  put('brand_name', context.brand);
  put('enquired_destination', context.enquiredDestination);
  put('preferred_trek', context.trek);
  put('trip_duration', context.tripLength);
  put('group_size', context.groupSize);
  put('travel_experience', context.experience);
  put('travel_timing', context.timing);
  put('special_requirements', context.specificRequirements);

  // Timezone hint: browser (CRM) first, a reliable phone-derived zone second, and
  // otherwise nothing — so the agent asks rather than receiving a raw/ambiguous
  // value. All emitted together so a hint always carries its source.
  const hint = resolveTimezoneHint(context, options.now ?? new Date());
  if (hint !== null) {
    put('customer_timezone', hint.tz);
    put('customer_timezone_label', hint.label);
    put('customer_timezone_source', hint.source);
    put('customer_local_time', hint.localTime);
  }

  return vars;
}

/** A resolved timezone suggestion and where it came from. */
interface TimezoneHint {
  tz: string;
  label: string;
  source: 'browser' | 'phone';
  /** Current local time in the zone (e.g. "3:00 PM"); undefined if unformattable. */
  localTime?: string;
}

/**
 * Resolves the timezone hint by strict priority: a valid CRM browser timezone,
 * then a RELIABLE single-zone phone region, else null. Normalisation and
 * validation reuse the shared timezone utilities; an ambiguous multi-zone region
 * (US, Russia, Australia, …) is deliberately not resolved.
 */
function resolveTimezoneHint(context: LeadCallContext, now: Date): TimezoneHint | null {
  // Priority 1 — browser timezone from the CRM.
  const browser = normalizeTimezone(context.customerTz);
  if (browser !== null) return withLocalTime('browser', browser, now);

  // Priority 2 — a reliable, unambiguous zone for the validated phone's region.
  const region = timezoneForRegion(context.phoneCountryIso);
  if (region !== null) {
    const phoneTz = normalizeTimezone(region);
    if (phoneTz !== null) return withLocalTime('phone', phoneTz, now);
  }

  // Priority 3 — nothing reliable; the agent establishes it conversationally.
  return null;
}

function withLocalTime(source: 'browser' | 'phone', tz: string, now: Date): TimezoneHint {
  const localTime = formatClockLabel(tz, now);
  return {
    tz,
    label: timezoneLabel(tz),
    source,
    ...(localTime === undefined ? {} : { localTime }),
  };
}
