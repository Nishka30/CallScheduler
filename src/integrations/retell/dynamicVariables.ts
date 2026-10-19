import type { LeadCallContext } from '../../services/leadContext.service.js';

/**
 * Maps our lead/person context onto the Travel Call Agent's dynamic variables.
 *
 * The published agent prompt uses exactly two template variables — `{{customer_name}}`
 * and `{{brand_name}}` — so this returns exactly those keys (without braces, as
 * Retell's `retell_llm_dynamic_variables` object requires) and nothing else. No
 * trip/destination/budget/date variables are invented.
 *
 * Missing values are handled safely by OMISSION: a key is only included when we
 * have a real value for it, so we never send an empty or fabricated name/brand.
 * (If the agent needs a default when a variable is absent, that belongs in the
 * Retell prompt configuration, which we do not modify.)
 *
 * All values are strings, as Retell requires. Returns `{}` when neither value is
 * available, and the caller should then omit `retell_llm_dynamic_variables`.
 */
export function buildAgentDynamicVariables(context: LeadCallContext): Record<string, string> {
  const vars: Record<string, string> = {};

  if (context.customerName && context.customerName.trim().length > 0) {
    vars['customer_name'] = context.customerName.trim();
  }

  if (context.brand && context.brand.trim().length > 0) {
    vars['brand_name'] = context.brand.trim();
  }

  return vars;
}
