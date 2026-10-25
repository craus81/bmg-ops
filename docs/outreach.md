# Outreach

Owner decision 2026-10-25 (Craig, thread "AI outbound sales agent"): FleetSuite finds new
local companies for each sales rep, writes a researched first email for each, and the rep
reviews and sends it under their own name. **Nothing sends itself** (see the CLAUDE.md
rule). Built in parts:

1. Unsubscribe link + postal address on marketing email (#1299, migration 437,
   `src/lib/email-unsubscribe.ts`).
2. **The weekly list** (migration 438): `/admin/outreach`, linked from Prospects.
3. Claude research + email draft per company, rep edits and taps Send (to come).
4. Pick-a-time / call-me page on the rep's calendar (to come).
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
