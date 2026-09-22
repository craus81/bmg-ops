# Usage telemetry (R7-4)

Where friction happens in the browser — client errors, slow pages, slow or
failing API calls, and forms people start but don't finish — recorded so
"the app is flaky on the tablets" can be answered with a page name instead
of a shrug. Read it on **System Health → Usage & errors**
(`/admin/system-health?tab=usage`, feature `system_health`).

## What is captured

| Signal | When | What the row holds |
| --- | --- | --- |
| `error` | uncaught JS error, unhandled promise rejection, script/stylesheet load failure | masked message (≤ 300 chars), source path, line/col, ≤ 5 stack frames as `path:line:col`, repeat count |
| `slow_page` / `page_timing` | every hard load and app-router navigation; timings over 3 s always, faster ones sampled 1-in-4 (`weight: 4`) | ms, LCP ms, hard/soft, request count |
| `api_slow` | same-origin `/api/*` or Supabase REST call (`supabase:<table>`) over 4 s, returning 5xx, or failing at the network (4xx are business outcomes, not recorded). The browser Supabase client resolves `fetch` per call (`src/lib/supabase-browser.ts`) so its requests pass through the telemetry wrapper even though the client is created before it installs | templated route, method, ms, status, failed flag |
| `form_start` / `form_submit` / `form_abandon` | forms opted in with `data-form` + `useFormTelemetry` | attempt id, seconds open, **count** of distinct touched fields, wizard step, exit reason (`navigate` / `close` / `pagehide`) |
| `queue_overflow` | the browser queue (200 events) overflowed | how many events were never sent |

Every row also carries the **templated page** (`/vehicles/:vin`,
`/book/:token`, `/admin/pos/:id`), the caller's **role** (resolved
server-side from the session; `anonymous` for the public forms; `NULL`
when a token was presented but could not be verified), a per-page-load
random **session id** that lives only in browser memory, and a coarse
**device family** (`ios-webview`, `android-chrome`, `desktop`, …).

## What is deliberately NOT stored

- **No user id.** The app runs on shared shop tablets; this is a friction
  log, not an employee activity log. Identity is resolved in flight only to
  rate-limit and to read a role, then discarded.
- **No IP address, no raw user-agent string** (only the device family).
- **No query strings or hashes** on any URL — `?email=…`, `?vehicle=…`,
  magic-link tokens on `/book/<token>`, `/approve/…/<token>`, `/portal/…`
  are templated to `:token` *in the browser* before the event is queued,
  and again on the server before insert.
- **No form field values, and no field names or ids.** The client never
  reads `input.value`; touched fields are counted by element reference in a
  `WeakSet`.
- **Masked free text**: e-mail addresses → `[email]`, uuids (the shape of
  every e-sign / magic-link token) → `[uuid]`, phone numbers →
  `[phone]`, VIN-shaped tokens → `[vin]`, digit runs of 4+ → `[n]`,
  anything in quotes or parentheses → `"[…]"` / `(…)`, Postgres
  `Key (col)=(value)` → `Key (…)=(…)`. Applied to messages, stacks, routes,
  and every string inside `detail`.
- **Unhandled rejections that are not `Error` instances** (supabase-js
  error objects, `Response`s, strings) record only their type — never their
  content. `Error`s whose message looks like JSON/HTML are recorded as
  `structured message dropped`.

The scrubbers live in `src/lib/usage-telemetry-sanitize.ts` (isomorphic,
unit-tested) and run on **both** sides — the server never trusts the
beacon. The table comment on `client_events` (migration 313) restates this.

## Reading the tab honestly

- **A gap is not evidence nothing went wrong.** Ad-blockers, offline
  tablets, the app being killed before `pagehide`, rate limiting and the
  kill switch all produce silence. Every count is a lower bound.
- A failed read renders **"unknown — couldn't load"**, never zeros.
- **Truncated windows say so**: the report reads at most 50,000 rows
  (newest first) for the chosen window (7 or 30 days) and flags it.
- **Forms**: started / submitted / abandoned are three independent tallies
  of distinct attempts. There is no "unknown = started − submitted −
  abandoned" — beacons drop and it goes negative. The submit ratio is
  shown as a lower bound.
- **Slow pages** need at least 5 weighted samples before a p50/p95 is
  shown ("too few samples" otherwise). Timings are sampled; slow loads are
  not.
- **Errors** are deduped by masked message + templated page and sorted by
  sessions affected, so one looping tablet doesn't dominate.
- Pages are always shown as text, never as links — templated ones have no
  record to land on, and a concrete page string is still client data. The
  only links on the tab are the filter / clear / purge-job links built from
  `deepLinks`.

## Retention and flood control

- `client_events` rows are purged after **30 days** by
  `/api/cron/client-events-purge` (04:41 UTC nightly; heartbeat
  `client_events_purge` on System Health → Jobs). It deletes in chunks of
  5,000 (≤ 20 per run) and also clears the rate-limit rows the beacon
  writes to `approval_rate_limits` after 2 days.
- The beacon route accepts ≤ 16 KB / 25 events per batch. A coarse
  **60 per minute** per-IP gate runs before any auth lookup (so a flood of
  junk bearer tokens never costs an auth API call each), then **6 batches
  per minute** per user-or-IP and **200 per hour** per session; anything
  over is dropped with a 204 (a client that retried would only add load).
- Restricted batches — no token at all (`anonymous`) **or** a token that
  did not verify (role `NULL`) — are accepted only for `/book/:token` and
  `/credit-application` with form ids `booking` / `credit_application`.
  An unverifiable bearer buys nothing more than no bearer.

## Kill switch

Set `NEXT_PUBLIC_TELEMETRY=off` in Vercel and **redeploy** — it is inlined
at build time, so flipping it without a deploy does nothing. With it set,
the browser installs no listeners and sends nothing; the Usage tab says so.

## Adding a form

1. Put `data-form="<id>"` on the form's root element (`[a-z0-9_]`, ≤ 60
   chars). Add `data-form-manual="true"` if typing is not the start signal
   and call `markStarted()` yourself (see the scan page).
2. In the component that owns the form state:
   `const formTel = useFormTelemetry('<id>', { active })` — `active`
   defaults to `true` (mounted = open); pass a flag for in-page forms that
   never unmount (`view === 'builder'`, `showCreate`).
3. Call `formTel.markSubmitted()` **only after the save resolved ok**;
   `markStep(n)` for wizards; `markAbandoned('close')` on explicit discard
   paths. Unmount, `active` → false, navigation and pagehide abandon
   automatically.
4. The tab counts **attempts, not records**. `markSubmitted()` starts a
   fresh attempt if the form stays open, so save → keep editing → back to
   the list is one submitted attempt and one abandoned one (the estimate
   builder does this on every save). Read an abandon count next to its
   median-open time before calling it friction.

First instrumented forms: `vehicle_checkin`, `estimate_builder`,
`po_receive`, `cni_job_new`, `prospect_create`, `scan_vin`,
`credit_application`, `booking`.

## Files

- `migrations/313-client-events.sql` — table, indexes, RLS, comments
- `src/lib/usage-telemetry-sanitize.ts` (+ test) — shared scrubbers
- `src/lib/usage-telemetry.ts` — browser core (queue, listeners, fetch wrapper, beacons)
- `src/lib/use-form-telemetry.ts` — the form hook
- `src/components/UsageTelemetry.tsx` — mount point (ClientProviders, credit-application layout, booking page)
- `src/app/api/client-events/route.ts` — POST ingest
- `src/app/api/admin/client-events/route.ts` + `src/lib/client-events-report.ts` (+ test) — the report
- `src/components/UsagePanel.tsx` — the tab
- `src/app/api/cron/client-events-purge/route.ts` — retention
- `deepLinks.systemHealthUsage(...)` — the only builder for links into the tab
