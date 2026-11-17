# Retell Travel Call Agent — Optimization Analysis (latest successful call)

**Analysis only — nothing in Retell was modified.** Source: live Retell API (GET calls/flow; `POST /v3/list-calls` is a read-only query). Agent `agent_e3152e8046a938387ba7a52cc1`, conversation flow `conversation_flow_68e14abb3d41` **v0** (current live, includes the meeting_type + date + booking-routing fixes).

---

## 1. The latest successful call — exact data

| Field | Value |
|---|---|
| Call ID | `call_19d4420bf4b5d66c166c079d3d1` |
| Agent / flow version | `agent_e3152e8046a938387ba7a52cc1` / conversation-flow **v0** |
| Start → End | 2026-11-17T06:32:46Z → 06:36:23Z (**217.7s**) |
| Status / disconnect | `ended` / `agent_hangup` |
| call_successful / sentiment | **true** / **Positive** |
| Booked | `{"booked":true,"appointment_id":"a6b48bc8-700e-49aa-9b1d-d445c6f13b2f","consultant":"David Urmann"}` |
| Appointment | `starts_at 2026-11-20T21:00:00Z` = **Fri Nov 20, 1:00 PM Pacific**, meeting_type **phone** |
| metadata | leadId `98f0587d-…`, callRecordId `f13d829a-…` |

**Dynamic variables provided to the call (the reliable timezone source):**
`customer_timezone: Asia/Calcutta` · `customer_timezone_label: India Standard Time` · `customer_timezone_source: browser` · `customer_local_time: 12:02 PM` · customer_name nishka · enquired Nepal · timing 2027 · duration 16+ days.

**Node transitions:** Welcome → Travel Qualification(42s) → Consultation Requested(50s) → Confirm Customer Local Time(61s) → **Get Available Slots(62s) → Offer(68s) → GAS(78s) → Offer(86s) → GAS(98s) → Offer(102s) → GAS(127s) → Offer(132s) → GAS(145s) → Offer(153s)** → Confirm Consultation(161s) → Book Consultation(184s) → Booking Confirmed(207s) → End Call(218s). **Five `get_available_slots` calls.**

**Every tool call — arguments → response (verbatim):**

| # | t | Tool | Arguments | Response |
|---|---|---|---|---|
| 1 | 62s | get_available_slots | `{"timezone":"America/Los_Angeles"}` | available:true, 3 slots Fri Nov 20 1:00/1:15/1:30 **PM Pacific** (`starts_at 2026-11-20T21:00/21:15/21:30Z`) |
| 2 | 78s | get_available_slots | `{"date":"2026-11-23","timezone":"America/Los_Angeles"}` | available:false ("No consultant available…") |
| 3 | 98s | get_available_slots | `{"date":"2026-11-24","timezone":"America/Los_Angeles"}` | available:false |
| 4 | 127s | get_available_slots | `{"date":"2026-11-25","timezone":"America/Los_Angeles"}` | available:false |
| 5 | 145s | get_available_slots | `{"timezone":"America/Los_Angeles"}` | available:true, **same Fri Nov 20** slots |
| 6 | 185s | book_consultation | `{"confirmed":true,"confirmed_destination":"Nepal","meeting_type":"phone","starts_at":"2026-11-20T21:00:00.000Z","timezone":"America/Los_Angeles",…}` | `{"booked":true,"appointment_id":"a6b48bc8…","consultant":"David Urmann"}` |

**Said vs. sent — the key discrepancy:** the agent *confirmed* "India Standard Time … 12:02 PM" with the customer (correct), but *sent* `America/Los_Angeles` to **all five** availability calls **and** the booking call. The customer was quoted "1 PM Pacific," which is **2:30 AM IST (Sat Nov 21)** — the timezone the customer confirmed was never actually used for slots or booking.

---

## 2. Timezone mistake — root cause (traced, not guessed)

Two symptoms, **one root cause: the agent used `America/Los_Angeles` — the agent-level configured timezone — instead of the confirmed `{{customer_timezone}}` (Asia/Calcutta).**

- **The "10:33 PM" first question.** Call start was 2026-11-17T06:32:46Z. In `America/Los_Angeles` (PST, UTC−8) that is **2026-11-16 22:33 → "10:33 PM."** So the first spoken estimate was the **current Pacific time**, i.e. the agent computed "now" in its own configured timezone. It was **not** `{{customer_local_time}}` (which was the correct "12:02 PM") — the model generated a clock time itself from the agent timezone instead of reading the provided variable. The agent-level setting is `timezone: America/Los_Angeles` (confirmed in the agent config).
- **The correct second question** ("India Standard Time … 12:02 PM") is the "Confirm Customer Local Time" node's CASE 1 script firing with `{{customer_timezone_label}}` + `{{customer_local_time}}`. So the node worked; the stray first line preceded/overrode it with a self-computed Pacific time.
- **The same Pacific default then leaked into every tool call.** Even *after* the customer confirmed IST, `get_available_slots` and `book_consultation` received `America/Los_Angeles`. This is the deeper bug: the model is not binding the `timezone` argument to `{{customer_timezone}}`; it defaults to the agent/business timezone.

**Why this matters beyond cosmetics:** for a `date` lookup, the backend converts the calendar date to a UTC day window *in the timezone passed* (`zonedDateRangeUtc(date, tz)`). Passing `America/Los_Angeles` means "Monday" was computed as **Pacific Monday**, a different 24h window than the customer's **IST Monday** — so the day-by-day "unavailable" answers were for the wrong day boundaries, and the final appointment was presented in a timezone the India-based customer never asked for.

**Checks performed:** not a stale variable (the correct `customer_local_time` was present and used in line 2); not a missing-data problem (`customer_timezone` was present and `source:browser`); not the tool returning tz late (tz is an input). It is specifically the agent defaulting to its configured `America/Los_Angeles` rather than the confirmed customer timezone.

**Desired behavior (per your spec):** never state a specific current clock time unless it comes from `{{customer_local_time}}`; otherwise just confirm the timezone label ("I have you in India Standard Time — is that right?"). And **always** pass `{{customer_timezone}}` (the confirmed IANA id) to both tools — never `America/Los_Angeles`.

---

## 3. Availability UX diagnosis (why it felt slow/tedious)

The conversation went: offer Fri → "Friday doesn't work, Monday?" → Mon unavailable → "Tuesday or Wednesday or any other day that week?" → agent checked **Tuesday** only → unavailable → asked again → **Wednesday** → unavailable → customer (frustrated): *"when is the next available? You find it, don't ask me the day"* → agent returned **the same Friday** → customer booked it.

Two concrete causes:

1. **The agent checks one named date at a time and does not interpret a range.** When the customer said "Tuesday or Wednesday or **any other day in that week**" (a clear range/open intent), the model picked a single date (Tuesday), then asked again, then Wednesday — four sequential round-trips. It never converted "any other day that week" into a `from`/`to` range, even though STEP 1.5 describes that. The model follows the literal first date and the "ask for another date" loop in the Offer node.
2. **"Next available" returns the *global* soonest, including an already-rejected slot.** Calls #1 and #5 are identical no-date lookups and both returned **Fri Nov 20** — the slot the customer had already rejected. So after rejecting the soonest, re-running next-available can only return the same slot; the only way to move past it is an explicit forward range (`from` = after the rejected date). The customer effectively gave up and took the slot they first declined.

Net: the booking "succeeded," but the customer spent ~80 seconds and 4 lookups to end up back at the first option, in a timezone that isn't theirs.

---

## 4. Better availability behavior (design)

Lead with next-available, and treat any range/open-ended phrasing as a **single** range search — never iterate day-by-day.

- **Always open with the soonest** (no-date call) and offer up to 3 — already happens, keep it.
- **On rejection of the soonest**, don't re-run the identical no-date call. Ask one light question ("roughly when works — later that week, next week, any particular day?") *or* immediately search forward with `from` = day after the rejected slot, `to` = `from` + ~14 days, and offer the earliest in that window.
- **Range / open intent → one `from`/`to` call.** "Monday through Saturday", "next week", "any day after Monday", "what else that week" → compute the window in `{{customer_timezone}}` and do a **single** search; offer the earliest 1–3.
- **Specific day → one `date` call** (as today), in `{{customer_timezone}}`.
- **Never** say "I'm checking" without the transition that actually fires the tool (already addressed by the date fix, but reinforce).

---

## 5. Does the tool support this? (schema + backend verified)

Tool schema (`get_available_slots`): `timezone` (required), `date`, `from`, `to`. Backend (`src/services/retellBookingFunction.service.ts`, verified): `date` → that calendar day's UTC window in the given tz (`zonedDateRangeUtc`); else `from`/`to` → forwarded range; else → CRM default "soonest" window. Returns up to **`SLOT_LIMIT = 3`** earliest slots; interactive timeout 8s, no retries.

| User intent | Current behavior | Desired behavior | Required change |
|---|---|---|---|
| **Specific date** ("Monday") | `date` sent, but in `America/Los_Angeles` (wrong tz) | `date` in `{{customer_timezone}}` | **Timezone binding** (flow); no schema change |
| **"Next week"** | Not recognized → day-by-day | one `from`/`to` = next week in customer tz | Flow: STEP 1.5 range mapping actually applied; **supported** by backend |
| **"Monday–Saturday"** | Not recognized → checks one day | one `from`/`to` spanning the window | Flow only; **supported** |
| **"Any other day / that week"** | Picks a single date, iterates | one `from`/`to` forward range | Flow only; **supported** |
| **"Next available"** | no-date call → returns global soonest (even if already rejected) | no-date for the *first* ask; after a rejection use `from` = rejected+1d | Flow: add "forward-from-rejected" rule; **supported** |
| **"Any day after Monday"** | Not recognized | `from` = Tue, `to` = +14d | Flow only; **supported** |

**No tool-schema change is required.** Everything needed is already supported; the gap is the flow not passing the right `timezone` and not converting range/open phrasing into one `from`/`to` call.

---

## 6. Latency / unnecessary tool calls

This call made **5** availability lookups where **1–2** would do; each interactive lookup can take up to ~8s. Concretely:
- Calls #2/#3/#4 (Mon/Tue/Wed, one at a time) should have been **one** `from`/`to` search for "that week."
- Call #5 repeated call #1 (same no-date → same Friday) — wasted, and returned a rejected slot.
- Reduce perceived latency by: (a) a single range search instead of N date searches; (b) returning/holding all 3 slots from one response; (c) not re-running an identical no-date search; (d) one short progress line max (already in the global prompt's function-execution rules); (e) transitioning to the function node the moment the customer expresses a date/range rather than narrating first. **Do not** drop the fresh-availability re-validation before booking (correctness).

---

## 7. Flow UX review (current v0 nodes)

- **Confirm Customer Local Time** — conflict: the node scripts a correct IST confirmation, but nothing forbids the model from first stating a self-computed time; the agent-level `America/Los_Angeles` leaks a wrong "now." Over-states a specific clock time. **(MUST FIX)**
- **Get Available Slots** — instruction says "use the customer's confirmed IANA timezone" but the model still sent `America/Los_Angeles`; the binding isn't explicit/strong enough, and there's no rule to prefer a single range search or to search forward after a rejection. **(MUST/SHOULD)**
- **Offer Available Slots.** — the empty-result path says "ask for another date," which nudges day-by-day; no path that says "if they're open/gave a range, do one forward/range search." **(SHOULD FIX)**
- **Confirm Consultation / Book Consultation / Booking Confirmed / Booking Not Confirmed** — working as intended after the prior fixes (booked===true gate, recovery path, meeting_type). The only issue is they inherit the wrong `timezone`; fixing tz upstream fixes the displayed/booked time. **No redesign.**

---

## 8. Preserved (do not change)

meeting_type collection + enum (phone/whatsapp/video), `booked===true` success detection, failure routing + recovery, exact `starts_at` passthrough, consultant selection, calendar creation, Booking Confirmed guardrail. No concrete bug found in any of these.

---

## 9. Optimization plan

### A. Root cause (timezone)
The agent used `America/Los_Angeles` (its configured agent-level timezone) instead of the confirmed `{{customer_timezone}}` = `Asia/Calcutta`: it spoke "10:33 PM" (current Pacific time) rather than `{{customer_local_time}}` ("12:02 PM"), and sent `America/Los_Angeles` to every `get_available_slots` and the `book_consultation` call — so slots/booking were computed and quoted in Pacific, not the customer's timezone.

### B. Availability UX diagnosis
The agent checks one named date at a time and doesn't convert range/open phrasing ("any other day that week", "next week") into a single `from`/`to` search; and "next available" returns the global soonest, so after the customer rejected Friday, re-running it returned Friday again. Result: 5 lookups to land back on the rejected slot.

### C. Recommended changes (for your approval — not applied)

1. **Confirm Customer Local Time** (`node-1793648807205`) — *MUST FIX*
   - Current: may state a self-computed "now"; wrong Pacific time leaked.
   - New: confirm the **timezone label only**, and if stating a time, use `{{customer_local_time}}` verbatim; never compute a clock time.
   - Prompt to add (near the top): *"Confirm only the timezone. Say: 'Before I check times, I have you in {{customer_timezone_label}} — is that correct?' Only state a current time if you quote {{customer_local_time}} exactly; never estimate or compute the current time yourself, and never use any timezone other than {{customer_timezone}}."*
   - No edge change.

2. **Get Available Slots** (`node-1792684792464`) — *MUST FIX (tz) + SHOULD (range)*
   - Add an explicit binding: *"Set the `timezone` argument to exactly `{{customer_timezone}}` (the confirmed IANA id, e.g. Asia/Calcutta). NEVER use America/Los_Angeles or the agent's own timezone."*
   - Add range/next-available rule: *"If the customer gave a range or open-ended availability ('next week', 'Monday–Saturday', 'any day after X', 'whatever's next'), make ONE call using `from`/`to` bounding that window in {{customer_timezone}} (omit `date`). For a plain 'next available' first ask, call with no date. If they rejected the soonest and want the next one, set `from` = the day after the rejected slot and `to` = `from` + 14 days. Do not check days one at a time."*
   - No schema change; no edge change.

3. **Offer Available Slots.** (`node-1792687749437`) — *SHOULD FIX*
   - In the empty-result branch, add: *"If the customer is open-ended or names more than one day, do a single range search (Get Available Slots with `from`/`to`) instead of asking for one specific date. Only ask for a specific date if they clearly want one."*
   - Keep the existing (already-broadened) re-check edge.

4. **Agent-level setting** — *SHOULD FIX*
   - The agent's `timezone` is `America/Los_Angeles`; it is the source of the "now" leak. Options: set it to a neutral/expected value, **or** (preferred, lower-risk) rely on the prompt rules above that forbid using it. Changing an agent setting is separate from the flow and reversible.

5. **Global prompt** — *MUST FIX (tz wording)*
   - In §3 (timezone) add a hard rule: *"Always pass `{{customer_timezone}}` to get_available_slots and book_consultation. Never pass America/Los_Angeles or the agent's timezone. Never speak a current clock time unless it is `{{customer_local_time}}` verbatim."*
   - In §4 add the range/next-available mapping as the default behavior (reinforcing STEP 1.5). No business rules removed.

**No tool-schema change required** (confirmed in §5).

### D. Latency improvements
Single range search instead of N date searches; don't repeat an identical no-date lookup; hold all 3 returned slots and offer them together; one progress line; transition to the function node the instant a date/range is expressed. Keep the pre-booking fresh re-validation.

### E. Revised ideal conversation
> **Agent:** Before I check times, I have you in India Standard Time — is that correct?
> **User:** Yes.
> **Agent:** The soonest I have is Friday, Nov 21 at 2:30 AM your time — that's quite early for you. Want me to look later that week or next week instead?
> **User:** Yeah, I'm free Monday through Saturday next week.
> **Agent:** Got it — checking Monday through Saturday next week. *(one `from`/`to` search in Asia/Calcutta)* The earliest are Tuesday 11:00 AM and Thursday 3:30 PM your time. Which works?
> **User:** Tuesday.
> **Agent:** And phone, WhatsApp, or video? … Great — booking Tuesday 11:00 AM, by phone. Confirm? … Done — you're booked with David Urmann.

### F. Change priority
- **MUST FIX:** (1) stop speaking a self-computed current time; (2) pass `{{customer_timezone}}` to both tools (not America/Los_Angeles) — this is a correctness bug (wrong-timezone day windows + customer quoted the wrong local time).
- **SHOULD FIX:** range/next-available single-search behavior (nodes 2–3), forward-from-rejected rule, agent-level timezone setting.
- **NICE TO HAVE:** proactively flagging when the soonest slot is an unsociable hour in the customer's timezone; trimming progress narration further.

---

*Nothing was changed in Retell. Raw call JSON and the current flow are saved under `retell-inspection/` (redacted). Recommend one test call afterward: an India-timezone customer who rejects the soonest and asks for "next week" — verify tools receive `Asia/Calcutta` and only one range search fires.*
