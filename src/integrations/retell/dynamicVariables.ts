import type { LeadCallContext } from '../../services/leadContext.service.js';

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
export function buildAgentDynamicVariables(context: LeadCallContext): Record<string, string> {
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

  return vars;
}
