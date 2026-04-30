# Sales guide

The **sales** role covers estimating, the prospects CRM, customer
setup, and the upfit project pipeline. You see Fleet GO + most of the
admin surface that touches the sales process — but not user
management, install checklist templates, or financial reports.

Default features (`ROLE_DEFAULT_FEATURES.sales`):
home, fleet check-in, in-shop, graphics, estimates, time, messages,
customers, parts catalog, quoting, schedule, prospects, upfit projects.

## How do I build an estimate?

1. Go to `/estimates`.
2. Click **New Estimate**.
3. Pick a customer (or create a new one).
4. Pick the vehicle(s) the estimate covers.
5. Click **Add Line Item** for each part / labor entry. Choose from the
   parts catalog or enter a custom line.
6. Fill in **Install Context** at the bottom — install instructions,
   site contact, special-handling notes. The customer's defaults
   pre-fill if you've set them; you can override per estimate.
7. Click **Save Draft** or proceed straight to **Send to Customer**.

Custom line items (anything not in the catalog) route through the
permanent NetSuite **FS-CUSTOM** item when pushed to a Sales Order.
Make sure FS-CUSTOM exists in NetSuite or the SO push will return 400.

## How do I send an estimate to a customer for approval?

1. Open the estimate.
2. Click **Send to Customer for Approval**.
3. Pick the channel: **Email**, **SMS**, or both. (SMS only fires when
   `SMS_PROVIDER_ENABLED=true`.)
4. Confirm.

The customer gets a magic-link URL valid for 30 days. They can
**Accept & Authorize Work** or **Request Changes** from a public page —
no login required. On accept, the estimate flips to `accepted` and an
immutable HTML snapshot is stored in the private `signed-documents`
bucket with full E-SIGN audit metadata (IP, user agent, time on page,
sha256 hash).

You'll get a notification when the customer responds. The estimate
won't auto-push to NetSuite — see "How do I convert an estimate to a
NetSuite Sales Order?".

For the customer's view, see `customer.md` and
`workflows/magic-link-approvals.md`.

## How do I resend an approval link?

1. Open the estimate.
2. Click **Resend Approval Link**.
3. Pick a channel.

Resend works even if the customer rejected once — sending again mints a
fresh token and re-opens the approval flow.

## How do I convert an estimate to a NetSuite Sales Order?

1. Open the accepted estimate.
2. Click **Convert to Sales Order**.
3. Confirm the line items mapping. Custom lines route through
   `FS-CUSTOM`; everything else maps to its NetSuite item.
4. Confirm.

The push:
- Carries estimate notes + install context into the NS memo (no more
  hardcoded boilerplate).
- Returns a summary with the NetSuite SO ID + number.
- Returns 400 with an `unmappedLines` list if any custom line couldn't
  route through `FS-CUSTOM` (usually because the item doesn't exist —
  ask your admin to create it).

## How do I set up customer defaults so estimates auto-fill?

Customer-default install context lives on the `customers` table and
auto-prefills every new estimate / check-in for that customer.

1. From a new estimate, pick the customer.
2. Click the pencil icon next to the customer row.
3. The `CustomerDefaultsEditor` modal opens.
4. Fill in:
   - **Delivery instructions** — pre-fills install instructions on
     estimates.
   - **Default site contact** — pre-fills check-ins.
   - **Notes for ops** — internal-only, surfaced to installers.
5. Save.

You can edit these any time. NetSuite sync never overwrites these
fields — they're FleetSuite-owned.

## How do I add or update a customer record?

1. Go to `/estimates` → **New Estimate** → **+ New Customer** in the
   picker. Or open an existing estimate and click the customer row.
2. Fill in name, billing address, ship-to, primary contact email + phone.
3. Save.

Customers come in two flavors:
- **NetSuite-synced** — pulled in automatically from NS, identified by
  `netsuite_id`. Most fields are sourced from NS.
- **App-only** — created in-app, no `netsuite_id` until later promoted
  via NS sync.

The app uses the same row for both; the source-of-truth depends on
which fields. Install context is always FleetSuite-owned (above).

## How do I move a prospect through the CRM pipeline?

1. Go to `/admin/prospects`.
2. Add a prospect — name, company, primary contact.
3. Drag-drop or use the stage dropdown to move them through stages
   (e.g. **Lead → Qualified → Proposal → Won → Lost**).
4. Add notes / next steps from the detail panel.
5. When they're ready to be a real customer, click **Convert to
   Customer** — this creates the `customers` row, transfers any
   threads / estimates, and removes them from the prospect board.

The **Sales Pipeline** widget on the home dashboard summarizes the
current pipeline by stage and value.

## How do I see active jobs grouped by my customer?

The **My Accounts — Active Jobs** widget on the home dashboard groups
all open graphics + fleet jobs by customer. Useful as a daily roll-up
before customer check-ins.

If it's not on your dashboard, click **Customize Dashboard** and add it.

## How do I create or link an upfit project?

Upfit projects are higher-level containers for an upfit job that may
have child graphics jobs linked to it.

1. Go to `/upfit`.
2. Click **New Project** or open an existing one.
3. Fill in customer, vehicle(s), description, and assigned ops lead.
4. Save.

When a graphics job is created from an estimate that references the
same vehicle, the system auto-links them. You can also link manually
from the upfit project page → **Linked Graphics Jobs** → **Add Link**.

The graphics job page now surfaces the parent upfit + customer in its
header so the graphics team has the same context.

## How do I check on a vehicle that's currently in the shop?

Sales has read access to `/tracking`. Find the vehicle, expand the row.
You'll see:

- Current status (`received`, `in_progress`, `complete`).
- Install context (from the estimate / customer defaults / per-vehicle
  notes).
- Completion notes (if completed).
- Linked graphics job and its production lane.
- Photo timeline (check-in, in-progress, completion photos and proofs).
- Read-only QC checklist.

If a customer is asking about ETA, this is the page to open.

## How do I send a customer a status update?

Use the **Message Customer** button on the vehicle row (in `/tracking`),
the estimate page, or the upfit project page. Each one opens or
creates a thread scoped to the right context, then drops you into
`/admin/inbox` with that thread selected.

If your shop has SMS enabled, you can choose SMS or email per message.
Otherwise email-only.

## How do I track which estimates are awaiting approval?

The **Open Quotes** widget on the home dashboard counts every estimate
that's in `sent` or `pending` status. Click into it to see the list
and resend approval links from there.

## How do I see my time / hours?

1. Go to `/time`.
2. Tap **Clock In** at the start of your day.
3. Tap **Start Break** when you take a break, **End Break** to resume.
4. Tap **Clock Out** at end of day.

Hours and weekly OT are calculated automatically. Past entries are
visible in the table below the clock card.

## How do I scan a VIN from my phone?

1. Go to `/scan`.
2. Tap **Scan VIN** to open the camera.
3. Point at the VIN barcode (windshield, door jamb, or registration).
4. The app decodes via NHTSA and either:
   - Auto-completes if the VIN is recognized, or
   - Falls back to manual entry.
5. Confirm and submit.

Last 8 chars of a VIN are enough for the partial-match lookup.
