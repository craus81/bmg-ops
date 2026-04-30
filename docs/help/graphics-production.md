# Graphics production guide

The **graphics_production** role (legacy name: `production`) covers the
graphics queue, proof creation and approvals, in-production status
transitions, and shipping. You see the graphics surface plus the
in-shop tracking, estimates (read), and customers / parts catalog
surfaces.

Default features (`ROLE_DEFAULT_FEATURES.graphics_production`):
home, in-shop, graphics, estimates, time, messages, customers, parts
catalog, quoting, schedule.

## How do I see all graphics jobs?

`/graphics` is the master queue. Each row is a graphics job with:

- Customer + vehicle (VIN)
- Stage (new → proof_pending → approved → in_production →
  ready_to_pickup → shipped → installed)
- Linked upfit project (if any)
- Latest proof file
- Approval status

Sort or filter by status, customer, or assigned designer using the
chips at the top.

## How do I create a graphics job?

Three ways:

1. **From an estimate** — When sales builds an estimate with graphics
   line items, the graphics job is auto-spawned on accept (and linked
   to the parent upfit project if one exists).
2. **From a PO** — When a PO with graphics SKUs is received, jobs are
   auto-created for each VIN. For multi-part jobs, the system can group
   ready-to-export scans by PO into a single job per PO.
3. **Manually** — `/graphics` → **New Graphics Job** → pick customer +
   vehicle + part numbers → save.

A single job can have multiple part numbers (vehicle decals, fender
graphics, ladder rack labels, etc.) — add them on the edit screen.

## How do I upload a proof file for customer review?

1. Open the graphics job at `/graphics/[id]`.
2. Click **Upload Proof**.
3. Drag the file in (PDF, PNG, JPG, AI export, etc.).
4. Add a label (e.g. "Front-quarter mockup v2").
5. Save.

You can upload as many proof files as you want. The list of files
appears in the **Proofs / Working Files** section.

## How do I send a proof for customer approval?

The customer should only see one selected proof file — not every
working file you've uploaded.

1. Open the graphics job.
2. Click **Send for Approval**.
3. The proof-file picker appears. **Pick exactly one** file as the
   proof.
4. Pick the channel: **Email**, **SMS**, or both. SMS only fires when
   `SMS_PROVIDER_ENABLED=true`.
5. Confirm.

The customer gets a magic-link URL valid for 30 days. They see only
the file you picked plus a clear approve / request-changes UI. On
approve, the file bytes are cloned into the private `signed-documents`
bucket with audit metadata. On reject, the job flips to `revision`
status with the customer's comment in `graphics_status_history`.

Until the customer approves, the job stays in `proof_pending`. Until
you've sent, it's `new`.

## How do I resend an approval link?

1. Open the graphics job.
2. Click **Resend Approval Link** (replaces **Send for Approval** once
   the first send has happened).
3. Pick a channel.

The previous token stays valid until expiry; a new token is also issued.
Both work — accept fires once.

## How do I move a job to "in production"?

After the customer approves, the job is in `approved`. Mark it
`in_production` once your team starts cutting / printing:

1. Open the job.
2. Click the status chip → **Mark In Production**.
3. (Optional) Assign a designer / production lead.

This signals the rest of the org that you've started.

## How do I download all working files for a job?

1. Open the graphics job.
2. Click **Download All** in the **Proofs / Working Files** section.

A server-side `jszip` route bundles every file in the job and streams
the ZIP back. Useful for sending to outside vendors or taking offline.

## How do I mark a job as ready to pick up?

When a job is fully produced and waiting for the customer to come get
it (rather than being shipped to the install bay):

1. Open the job.
2. Click the status chip → **Mark Ready to Pickup**.

This auto-fires a customer notification ("your graphics are ready").
The customer notification fields come from the customer's profile.

## How do I mark a job as shipped?

1. Open the job.
2. Click the status chip → **Mark Shipped**.
3. Fill in tracking number / carrier (optional but recommended).

This:
- Notifies Craig George + Jessie Whittington (UUIDs hardcoded in
  `notify-shipped-invoice`) that an invoice is needed.
- Shows them an invoice prompt in their notifications. Clicking it
  opens the `GraphicsInvoiceModal` with `?invoiceJob=<id>` in the URL.

## How do I create a NetSuite invoice for a shipped graphics job?

1. From the bell notification, click the **Create Invoice** action. (Or
   open the job directly and click **Create Invoice**.)
2. The `GraphicsInvoiceModal` opens.
3. Pick a customer (defaults to the job's customer).
4. Pick line items — each defaults to one row per part on the job at
   the catalog rate.
5. Adjust qty / rate as needed.
6. Click **Create Invoice**.

This calls `/api/netsuite/create-invoice-direct` which creates a
standalone NetSuite invoice (no SO required) and writes the
`netsuite_invoice_id`, `netsuite_invoice_number`, and `invoiced_at`
fields back onto the graphics job.

## How do I link a graphics job to its parent upfit project?

Most jobs auto-link from their estimate. To link manually:

1. Open the graphics job.
2. Scroll to the **Parent Upfit Project** section.
3. Click **Link to Project**.
4. Search by customer or VIN.
5. Pick the project.

The graphics job page shows the parent upfit + customer in its
header once linked.

## How do I see only my assigned jobs?

1. `/graphics` → filter chip **Mine**.
2. Or the **My Jobs** widget on the home dashboard.

## How do I tell ops the graphics are ready for install?

When a job's production status is `ready` (production complete, ready
for install), the system narrowly notifies:
- Installers assigned to the matching vehicle, plus
- Admins, plus
- Anyone who's opted in to **Notify me when ready for install**.

It does **not** notify everyone with `notify_ready=true` (legacy
behavior; replaced by the targeted approach in T1.1).

You typically don't have to push a button for this — moving the job
to `ready` from the status chip auto-fires the notification.

## How do I run a "ready to pickup" reminder?

Currently this is a manual click — open the job, set it to
`ready_to_pickup`, the notification fires once. There's no automatic
re-reminder if the customer doesn't respond. For now, escalate by
sending a thread message via **Message Customer**.

## How do I handle a customer-supplied graphic?

For jobs where the customer is providing the artwork (instead of BMG
designing it):

1. Create the graphics job.
2. Upload the customer's file as a proof.
3. Use the `proof_url` field if you want the magic-link approval page
   to embed an external link instead of the in-app file.
4. Send for approval as normal — the public approval page falls back
   to `proof_url` when the file is external.

## How do I see the photo timeline for a vehicle's full job lifecycle?

The pick-list (`/vehicles/[vin]/pick-list`) and the in-shop tracking
expanded panel both show a unified photo timeline that combines:
- Check-in photos
- Graphics proofs
- Graphics design files
- Completion photos

You can filter by category and click for the keyboard-nav lightbox.

## How do I track sales-by-customer revenue?

`/admin/reports` → **Sales by Customer Detail** runs against NetSuite
SuiteQL and is read-only for graphics_production. Useful for ranking
top accounts before quarterly check-ins.

The **Top 5 Customers YTD** widget on the home dashboard shows the
condensed view.
