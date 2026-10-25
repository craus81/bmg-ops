# Outreach

Owner decision 2026-10-25 (Craig, thread "AI outbound sales agent"): FleetSuite finds new
local companies for each sales rep, writes a researched first email for each, and the rep
reviews and sends it under their own name. **Nothing sends itself** (see the CLAUDE.md
rule). Built in parts:

1. Unsubscribe link + postal address on marketing email (#1299, migration 437,
   `src/lib/email-unsubscribe.ts`).
2. **The weekly list** (migration 438): `/admin/outreach`, linked from Prospects.
3. **Drafts and Send** (migration 439): Claude research + email draft per company, rep edits and taps Send.
4. **Pick a time / Call me** (migration 440): two buttons on every Outreach email, public `/meet/<token>` page.
5. A follow-up draft a week after no answer, for the rep to review (to come).

## The weekly list

- **Who**: every approved, active user with the **Sales** role gets 25 companies each
  Monday (cron `/api/cron/outreach-fill`, Mondays 11:03 UTC; System Health
  `outreach_fill`). Admins can open any rep's list and tap **Find companies now**,
  which only fills gaps.
- **Where**: within 100 straight-line miles of the 63366 ZIP centre
  (`src/lib/outreach-area.ts`, a static ZIP→miles list).
- **Fleets**: the FMCSA Company Census File on data.transportation.gov (dataset
  az4n-8mr2): 5–500 power units, a phone or email on file. Free, no key; an optional
  `SOCRATA_APP_TOKEN` raises the rate limit.
- **Trades**: Google Places Text Search (plumbers, HVAC, electricians, landscaping,
  roofing, pest control, garage doors, restoration), rotating search towns week to week.
  Needs `GOOGLE_MAPS_API_KEY` (Places API (New) enabled); about $0.035 per search, at
  most 16 per run. Without the key the list is fleets only and the page says so.
- **Never twice**: one `outreach_targets` row per company ever (`source, source_id`
  unique). Anyone matching a Customer or Prospect by company name, phone or email is
  skipped, and unsubscribed addresses are dropped.
- Half fleets, half trades, nearest first, dealt round-robin across reps.

## Drafts and Send

- **Drafting** (`src/lib/outreach-draft.ts`): reads the company's home, /contact and /about
  pages (public http(s) only, 8 s timeout, text capped), finds an email address (own domain
  first), and asks Claude (`OUTREACH_MODEL`, default claude-sonnet-5-5) for a 90–140 word
  email plus 2–3 "why this company" lines, using only the facts given. A company with no
  email found goes to **Call first**; its draft is still written.
- The cron `/api/cron/outreach-draft` (weekdays, hourly at :28, 11–23 UTC; System Health
  `outreach_draft`) drafts up to 15 new companies per run. On the page: **Write email** /
  **Rewrite** per row, and **Write all emails**. A failed draft shows its reason in red
  and is not retried by the cron; Rewrite retries it.
- **Send**: **Review & send** opens the standard compose screen
  (`EmailComposeModal`, with the draft prefilled via `initialMessage`) and a Subject
  field. Only the rep whose list it is can send. The email is From "<rep> via BMG Fleet"
  with Reply-To set to the rep, and each To address gets its own copy with the address +
  unsubscribe footer and List-Unsubscribe headers. Unsubscribed addresses are refused.
- The first send makes the company a prospect (`source` 'outreach', lead source
  **Outreach**, `created_by` the rep), or links an existing matching prospect. The email
  lands on its timeline (email log, kind `outreach`).

## Pick a time / Call me

- Every Outreach send carries two buttons under the message: **Pick a time to talk** and
  **Have <rep> call me**. Both open `/meet/<token>` (no login; `booking_token` on the
  target, 40 hex, minted on first send). Nothing is emailed back to the customer.
- **Pick a time** (`src/lib/outreach-meet.ts`): 20-minute phone calls, weekdays
  9:00 to 16:00 Central, the next 8 weekdays from tomorrow, minus any timed entry already
  on the rep's FleetSuite schedule (all-day entries don't block). Phone required. A booking
  adds a `calendar_events` row for the rep (category `sales`, "Call: <company>"), sets the
  row to **Call booked**, and logs a meeting on the prospect.
- **Call me**: phone required, best time optional. Sets the row to **Call them back** and
  logs a call request on the prospect.
- Either one notifies the rep at once (`outreach_response`: bell, push and email).
