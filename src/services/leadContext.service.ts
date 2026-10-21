import type { LeadDetail, LeadListRow, PersonHistory } from '../integrations/leadApi/schemas.js';
import { parseTimestamp, readPhoneVerdict } from './leadEligibility.service.js';

/**
 * One questionnaire answer from the lead's travel-form session.
 *
 * CONFIRMED shape of `answers[]` on `GET /api/crm/leads/<id>`.
 */
export interface FormAnswer {
  questionId: string;
  prompt: string;
  answer: string;
  position?: number;
  answeredAt?: string;
}

/**
 * Everything a future Retell call needs about one lead, normalized from the
 * Lead API responses.
 *
 * Built in memory and handed to the caller; it is deliberately NOT persisted.
 * The Lead API stays the source of truth, and Phase 3 re-fetches at call time
 * so the agent never speaks from a stale local copy.
 *
 * Every field is optional: nothing here is invented when the API omits it.
 */
export interface LeadCallContext {
  leadId: string;
  personKey?: string;
  /** Validated E.164 number. Absent unless `valid === true`. */
  phoneE164?: string;
  /** Verdict metadata, e.g. `live_mobile` / `mobile`. */
  phoneTier?: string;
  phoneLineType?: string;

  customerName?: string;
  brand?: string;
  country?: string;
  city?: string;
  /** Free-text the customer typed on the form. */
  freeText?: string;
  /**
   * The destination the lead originally enquired about, derived from the funnel
   * page they completed (`page_slug`, e.g. `nepal` → `Nepal`). This is the
   * submitted enquiry, NOT anything the customer says on the call; the two are
   * kept distinct so the agent can reference the enquiry and still let the
   * customer change it.
   */
  enquiredDestination?: string;

  /**
   * `caller_hold_until`, verbatim, when present and parsable.
   *
   * An officially supported field (David's revised contract): an ISO timestamp
   * or null. A future value reserves the lead for the AI Caller, blocking a
   * human sales agent from claiming it through the CRM until the hold lapses.
   * It is carried through as timing information for a future caller - NOT an
   * eligibility gate (see `leadEligibility.service.ts`) - and is interpreted by
   * `evaluateCallWindow()` in `callWindow.service.ts`. Its presence here never
   * implies a call has been attempted; that is tracked separately per lead id
   * in `callRecord.repository.ts`.
   */
  callerHoldUntil?: string;

  /** Travel intent, lifted from the confirmed questionnaire ids. */
  trek?: string;
  groupSize?: string;
  tripLength?: string;
  timing?: string;
  experience?: string;
  beenBefore?: string;
  /**
   * The lead's own "specific requirements / questions" answer (or the form's
   * free text if that question was not asked). Free-form customer intent — never
   * treated as a confirmed fact, only as something the agent can acknowledge.
   */
  specificRequirements?: string;

  /** All answers, kept whole so nothing is lost by the mapping above. */
  answers: FormAnswer[];
  /** Other simple lead columns, by name. */
  leadFields: Record<string, string>;
  history?: PersonHistorySummary;
}

/** Non-identifying summary of prior activity, for call context. */
export interface PersonHistorySummary {
  priorInquiryCount: number;
  bookingCount: number;
  noteCount: number;
  /** From `profile.counts.calls` - has this person been called before? */
  priorCallCount?: number;
  /** Already-assigned sales agent, so a booking can be routed to them. */
  currentAgentEmail?: string;
  currentStatus?: string;
}

/**
 * Questionnaire ids confirmed against the live travel form.
 *
 * The travel details live in `answers[]`, NOT in lead columns: the lead row has
 * no destination, dates, party-size or budget column. (There is no budget
 * question on the form at all.)
 */
const QUESTION_IDS = {
  trek: 'confirm_trek', // "What kind of Nepal trek are you considering?"
  groupSize: 'group_size', // "How many are in your group?"
  tripLength: 'trip_length', // "How long do you have for the trip?"
  timing: 'timing', // "When are you looking to start the trek?"
  experience: 'experience', // "How much trekking or hiking experience do you have?"
  beenBefore: 'been_before', // "Have you been trekking in Nepal before?"
  specific: 'specific', // "Do you have any specific requirements or questions?"
} as const;

/** Columns never copied into call context, confirmed against the live schema. */
const EXCLUDED_COLUMNS = new Set([
  // Contact details: handled explicitly, never bulk-copied.
  'email',
  'email_original',
  'normalized_email',
  'phone',
  'whatsapp',
  // Internal identifiers.
  'person_id',
  'person_uuid',
  'legacy_id',
  'session_id',
  'visitor_id',
  'ac_contact_id',
  // Surfaced explicitly as `callerHoldUntil`, not bulk-copied.
  'caller_hold_until',
  // Attribution and click tracking.
  'attribution_source',
  'attribution_touch_at',
  'attribution_evidence',
  'click_id',
  'gclid',
  'msclkid',
  'fbclid',
  'page_slug',
]);

/**
 * Builds the call context from a lead detail response.
 *
 * Corrections win: `current` is the row with the latest edits overlaid, so it
 * is preferred over `captured`. `captured` is never modified or written back.
 *
 * Questionnaire answers are carried through whole as well as mapped. Their
 * presence is not treated as verification of anything - the agent still
 * confirms details naturally rather than assuming a form answer is still true.
 */
export function buildLeadCallContext(
  leadId: string,
  detail: LeadDetail,
  options: { listRow?: LeadListRow; history?: PersonHistory } = {},
): LeadCallContext {
  const current = detail.current ?? {};
  const captured = detail.captured ?? {};
  const read = (column: string): string | undefined =>
    asShortString(current[column]) ?? asShortString(captured[column]);

  const answers = normalizeAnswers(detail.answers);

  const context: LeadCallContext = {
    leadId,
    answers,
    leadFields: collectLeadFields(current, captured),
  };

  const personKey = detail.personKey ?? options.listRow?.person_key ?? undefined;
  if (personKey) context.personKey = personKey;

  const verdict = readPhoneVerdict(detail.phone);
  if (verdict.status === 'valid') {
    context.phoneE164 = verdict.e164;
    if (verdict.tier !== undefined) context.phoneTier = verdict.tier;
    if (verdict.lineType !== undefined) context.phoneLineType = verdict.lineType;
  }

  const customerName = read('name');
  if (customerName) context.customerName = customerName;

  const brand = read('brand');
  if (brand) context.brand = brand;

  const country = read('country');
  if (country) context.country = country;

  const city = read('city');
  if (city) context.city = city;

  const freeText = read('free_text');
  if (freeText) context.freeText = freeText;

  // Destination the lead enquired about. `page_slug` is the funnel page they
  // completed (e.g. `nepal`); we present it readably but never invent a value.
  const pageSlug = read('page_slug');
  const enquiredDestination = pageSlug ? humanizeSlug(pageSlug) : undefined;
  if (enquiredDestination) context.enquiredDestination = enquiredDestination;

  const callerHoldRaw = read('caller_hold_until');
  if (callerHoldRaw && parseTimestamp(callerHoldRaw) !== null) {
    context.callerHoldUntil = callerHoldRaw;
  }

  const byId = new Map(answers.map((answer) => [answer.questionId, answer.answer]));

  const trek = byId.get(QUESTION_IDS.trek);
  if (trek) context.trek = trek;

  const groupSize = byId.get(QUESTION_IDS.groupSize);
  if (groupSize) context.groupSize = groupSize;

  const tripLength = byId.get(QUESTION_IDS.tripLength);
  if (tripLength) context.tripLength = tripLength;

  const timing = byId.get(QUESTION_IDS.timing);
  if (timing) context.timing = timing;

  const experience = byId.get(QUESTION_IDS.experience);
  if (experience) context.experience = experience;

  const beenBefore = byId.get(QUESTION_IDS.beenBefore);
  if (beenBefore) context.beenBefore = beenBefore;

  // The lead's own free-form requirements. Prefer the dedicated question; fall
  // back to the form free text when that question was not part of the funnel.
  const specificRequirements = byId.get(QUESTION_IDS.specific) ?? context.freeText;
  if (specificRequirements) context.specificRequirements = specificRequirements;

  if (options.history) {
    context.history = summarizePersonHistory(options.history);
  }

  return context;
}

/** Keeps only well-formed answers; a malformed entry is dropped, not guessed. */
function normalizeAnswers(raw: unknown): FormAnswer[] {
  if (!Array.isArray(raw)) return [];

  const answers: FormAnswer[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const questionId = asShortString(record['questionId']);
    const prompt = asShortString(record['prompt']);
    const answer = asShortString(record['answer']);
    if (!questionId || !prompt || !answer) continue;

    const position = record['position'];
    const answeredAt = asShortString(record['answeredAt']);

    answers.push({
      questionId,
      prompt,
      answer,
      ...(typeof position === 'number' ? { position } : {}),
      ...(answeredAt === undefined ? {} : { answeredAt }),
    });
  }

  return answers;
}

/**
 * Condenses the CRM profile rather than copying it wholesale.
 *
 * CONFIRMED profile keys: identity, counts, money, salesAgent, leadStatus,
 * tripStatus, source, timeline, freeText, latestActivityAt, legacy,
 * paymentRecords.
 *
 * `salesAgent` was null throughout the sampled data, so its populated shape is
 * unverified; both a bare string and an object with an `email` are accepted.
 */
export function summarizePersonHistory(history: PersonHistory): PersonHistorySummary {
  const profile = history.profile ?? {};

  const summary: PersonHistorySummary = {
    priorInquiryCount: history.leads?.length ?? 0,
    bookingCount: history.bookings?.length ?? 0,
    noteCount: history.notes?.length ?? 0,
  };

  const counts = profile['counts'];
  if (typeof counts === 'object' && counts !== null) {
    const calls = (counts as Record<string, unknown>)['calls'];
    if (typeof calls === 'number') summary.priorCallCount = calls;
  }

  const agentEmail = readAgentEmail(profile['salesAgent']);
  if (agentEmail) summary.currentAgentEmail = agentEmail;

  const status = asShortString(profile['leadStatus']);
  if (status) summary.currentStatus = status;

  return summary;
}

function readAgentEmail(salesAgent: unknown): string | undefined {
  if (typeof salesAgent === 'string') return asShortString(salesAgent);
  if (typeof salesAgent !== 'object' || salesAgent === null) return undefined;

  const record = salesAgent as Record<string, unknown>;
  return asShortString(record['email']) ?? asShortString(record['agent_email']);
}

/**
 * Copies simple scalar lead columns, minus anything excluded.
 *
 * Only strings and numbers are kept: nested objects are where raw provider
 * payloads and attribution blobs live.
 */
function collectLeadFields(
  current: Record<string, unknown>,
  captured: Record<string, unknown>,
): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const source of [captured, current]) {
    for (const [key, value] of Object.entries(source)) {
      if (EXCLUDED_COLUMNS.has(key)) continue;
      const text = asShortString(value);
      if (text !== undefined) merged[key] = text;
    }
  }

  return merged;
}

/**
 * Turns a funnel page slug into a readable destination label without inventing
 * anything: separators become spaces and each word is capitalised. `nepal` →
 * `Nepal`, `everest-base-camp` → `Everest Base Camp`. Returns undefined for a
 * slug that carries no letters/digits, so junk is dropped rather than spoken.
 */
function humanizeSlug(slug: string): string | undefined {
  const words = slug
    .trim()
    .split(/[\s\-_]+/)
    .map((word) => word.trim())
    .filter((word) => /[a-z0-9]/i.test(word));
  if (words.length === 0) return undefined;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function asShortString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 2000 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Safe log representation of a context.
 *
 * The context holds a customer's name, phone number and travel plans, so it is
 * never logged in full. Only presence flags and counts are emitted.
 */
export function describeContextForLog(context: LeadCallContext): Record<string, unknown> {
  return {
    leadId: context.leadId,
    hasPersonKey: context.personKey !== undefined,
    hasValidatedPhone: context.phoneE164 !== undefined,
    phoneTier: context.phoneTier,
    // A timestamp, not personal data - useful to see the call-attempt deadline.
    callerHoldUntil: context.callerHoldUntil,
    hasName: context.customerName !== undefined,
    hasEnquiredDestination: context.enquiredDestination !== undefined,
    hasTrek: context.trek !== undefined,
    hasTiming: context.timing !== undefined,
    hasSpecificRequirements: context.specificRequirements !== undefined,
    answerCount: context.answers.length,
    leadFieldCount: Object.keys(context.leadFields).length,
    priorInquiries: context.history?.priorInquiryCount,
    priorCalls: context.history?.priorCallCount,
    hasAssignedAgent: context.history?.currentAgentEmail !== undefined,
  };
}
