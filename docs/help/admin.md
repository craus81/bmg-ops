# Admin guide (FleetSuite)

The **admin** role sees every feature in the app. The header brands as
**FleetSuite** + "Admin", and the AI assistant is unrestricted.

This is the guide for shop owners, ops managers, and anyone who has been
given the admin role at **Admin → Users**.

For role-by-role workflows you'll be administering, also read:
- `sales.md`
- `graphics-production.md`
- `installer.md`
- `shop-and-field-tech.md`
- `customer.md`

## How do I approve a new user?

When someone new logs in, their account is `pending` until you approve
them.

1. Go to `/admin/users`.
2. Find the row in the **Pending** section at the top.
3. Click **Approve**.
4. Pick the user's role(s): admin, sales, graphics_production, shop_tech,
   field_tech, installer, or customer.
5. (Optional) Toggle per-feature overrides if this user needs more or less
   access than the default for their role. Defaults are defined in
   `src/lib/features.ts` under `ROLE_DEFAULT_FEATURES`.
6. Save.

The user gets an email saying their account is live. They can sign in
immediately with a fresh magic link.

## How do I give a user multiple roles?

Profiles support both `role` (single, legacy) and `roles` (text[], the
modern field). The auth provider unions whichever is present.

1. Go to `/admin/users` → click the user.
2. In the **Roles** section, check every role they should have.
3. Save.

Granting `admin` overrides all feature gates regardless of other roles.

## How do I revoke or change someone's access?

1. `/admin/users` → click the user.
2. Either:
   - Uncheck a role to remove just that surface, or
   - Click **Set Status → Denied** to lock them out entirely.
3. Save.

A denied user keeps their account row but hits the "not approved" banner
on every login. Re-approve to restore.

## How do I add a custom feature exception for one person?

1. `/admin/users` → click the user.
2. Scroll to **Feature Overrides**.
3. Toggle **Granted** or **Denied** for the specific feature key.
4. Save.

Overrides win over role defaults. Useful when, for example, a sales rep
also needs access to **Bulk VIN Upload** even though that's not a sales
default.

## How do I manage the install checklist templates?

Default templates seed on first deploy: **Upfit**, **Graphics**, and
**Mixed**. Each defines what items installers must complete before they're
allowed to mark a vehicle complete.

1. Go to `/admin/install-checklists`.
2. Pick a template or click **New Template**.
3. Add / edit checklist items. Mark items **Required** if they must be
   checked off before completion is allowed. Required items hard-block
   the **Mark Complete** transition.
4. Save.

When a vehicle moves from `received` to `in_progress` (the first time an
installer touches the pick-list), the matching template is cloned into
`job_tasks` rows for that vehicle.

If you change a template after a job is in progress, **already-running
jobs do not re-clone**. Only newly-started jobs pick up the change.

## How do I monitor every vehicle in the shop?

The **In-Shop Tracking** page at `/tracking` is the master operations
view.

- Each row is a vehicle with its current status (`received`,
  `in_progress`, `complete`).
- Expand a row to see install context, completion notes, the matched
  graphics job, the photo timeline, and a read-only QC checklist.
- The **Run Completion Process** button on a row in `in_progress` opens
  the same `CompletionModal` an installer would see — useful when an
  admin needs to finalize on behalf of an installer.
- The **Graphics install lane** column shows whether a vehicle's linked
  graphics job is also done; both lanes must be green for the row to
  flip to `complete`.

## How do I see and respond to customer messages?

The unified inbox at `/admin/inbox` is one queue across SMS, email, and
in-app threads.

1. Filter tabs: **Unassigned**, **Mine**, **All**, **Archived**, **Unknown**.
2. Click a thread to open the detail panel.
3. Click **Assign to me** to claim it.
4. Use the composer at the bottom to reply via SMS or email.
5. Click **Archive** when the conversation is done.

Threads are scoped polymorphically — a thread is tied to a fleet check-in,
PO, graphics job, estimate, customer, or none. The context badge at the
top of the thread tells you what it's about.

If an unknown number texts in, the system auto-creates an `external_contacts`
row with `is_unknown=true` and starts a thread. Convert it by editing the
contact and matching it to a real customer.

## How do I send a customer comms message from anywhere in the app?

Most contexts have a **Message Customer** button (e.g. the pick-list, the
estimate page, `/tracking`). Clicking it opens or creates a thread scoped
to that context, then drops you into the inbox with that thread selected.

Under the hood this calls the shared `openOrCreateVehicleThread` helper.

## How do I set up the FS-CUSTOM NetSuite item?

Required before any estimate that has custom line items can be pushed to
NetSuite as a Sales Order.

1. Log in to NetSuite.
2. Lists → Items → New.
3. Item Number: **FS-CUSTOM** (exact string, case-sensitive).
4. Type: NonInventory or Service.
5. Income / COGS accounts: assigned per your accounting setup.
6. Save.

Without this, `/estimates` → SO push returns 400 with an `unmappedLines`
list and the estimate stays in `accepted` until the item is created.

## How do I run a NetSuite report?

1. Go to `/admin/reports`.
2. Pick a report (e.g. **Sales by Customer Detail**).
3. Set the date range and filters.
4. Click **Run**.
5. Export to CSV from the result table if needed.

Reports run against NetSuite via SuiteQL. They're read-only. Negative
numbers in the sales-by-customer detail report are fine — they're
returns / credit memos.

## How do I upload reference docs to the knowledge base?

1. Go to `/admin/knowledge`.
2. Click **Upload Document**.
3. Drag in a PDF, DOCX, XLSX, CSV, TXT, MD, or image.
4. Pick a category (`SOP`, `spec`, `pricing`, `process`, `policy`, `help`,
   `other`).
5. Add tags (the AI uses these to weight relevance).
6. Save.

The file goes to the `knowledge-files` Supabase storage bucket; extracted
text + metadata go into `knowledge_docs`. The FleetSuite AI assistant
indexes this within minutes.

To re-extract text from an old file (e.g. after a parser fix), open it
and click **Reprocess**.

## How do I edit the in-app help library?

The articles you're reading live in `docs/help/*.md` in the
`craus81/bmg-ops` repo. Edit those files.

To re-seed the in-app knowledge base after edits:

```
node scripts/sync-help-docs.mjs
```

That clears the `help` category and re-inserts one row per markdown file.

## How do I manage prospects (CRM)?

1. Go to `/admin/prospects`.
2. Add a prospect (name, company, contact).
3. Move them through pipeline stages.
4. Convert to a customer when ready — that creates the customer row and
   links any threads / estimates over.

The **Sales Pipeline** widget on the home dashboard summarizes this.

## How do I export a vehicle spreadsheet for a customer?

1. Go to `/admin/reports` (or `/reports` for non-admin sales).
2. Pick **Vehicle Export**.
3. Filter by customer / date / status.
4. Click **Export CSV**.

CSV includes VIN, make/model, current status, last check-in date, and
linked graphics job status.

## How do I bulk-upload VINs?

1. Go to `/admin/bulk-upload`.
2. Pick a template (CSV with VIN column required).
3. Drag the file in.
4. The page shows a preview with NHTSA decode results per row.
5. Review and confirm.
6. Submit. Rows go into `scan_logs` and create stub vehicle rows.

Failed rows show inline errors (invalid VIN format, duplicate within
the file, etc.). Fix and re-upload only the failed rows.

## How do I set up customer-default install context?

Per-customer settings that auto-prefill on every new estimate / check-in.

1. From any estimate, pick the customer.
2. Click the pencil icon next to the customer row.
3. The `CustomerDefaultsEditor` modal opens.
4. Fill in:
   - **Delivery instructions** — pre-fills new estimates.
   - **Default site contact** — pre-fills check-ins.
   - **Notes for ops** — internal-only.
5. Save.

These fields live on the `customers` table and are FleetSuite-owned —
NetSuite sync never overwrites them.

## How do I see who's clocked in right now?

- **Time Clock** widget on the home dashboard (add it from **Customize
  Dashboard** if it isn't there).
- Full timesheet view at `/admin/reports` → **Time Clock** report.

Includes break tracking and weekly OT calculations.

## How do I troubleshoot a vehicle that won't mark complete?

The **Mark Complete** button hard-blocks if any of these are true:

1. No completion photo captured.
2. A required QC checklist item is unchecked.
3. The linked graphics install lane is not green (graphics job not yet
   `installed`).

Check the response from `/api/vehicle-tracking/update-status` — it returns
422 with a `missing` array listing the specific reasons.

As an admin you can force-override from the pick-list (button labeled
**Force Complete (Admin)**), which skips the checks but still records
who forced it and why in the audit trail.

## How do I configure environment / deploy settings?

These live in the Vercel project settings, not in the app:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL` — used to build approval / email links.
  Without this, links may render as `http:///approve/…`.
- `RESEND_API_KEY`, push notification VAPID keys.
- `SMS_PROVIDER_ENABLED` (default `false`), `SMS_PROVIDER`
  (`twilio` | `ringcentral`).
- `RC_*` vars for RingCentral once A2P 10DLC clears.

A Vercel deploy auto-redeploys on every push to `main`.

## How do I run pending database migrations?

1. SSH into the Supabase project's SQL Editor (Dashboard → SQL → New
   query).
2. Paste in the migration file content from `migrations/<NNN>-*.sql`.
3. Click **Run**.
4. Confirm no errors.

Migrations are idempotent (CREATE IF NOT EXISTS / ALTER ADD IF NOT
EXISTS / etc.), so running them twice is safe. Always run them in
ascending number order.
