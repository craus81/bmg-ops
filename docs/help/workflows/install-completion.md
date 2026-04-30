# Workflow: install completion ceremony

The structured flow at the end of a vehicle's time in the shop. Ensures
the QC checklist is done, completion photos are captured, the customer
gets notified, and the office has audit evidence the work was finished
properly.

Migration that introduced this: `073-install-completion-ceremony.sql`.
Refined into a focused modal walkthrough in subsequent commits.

## Where it runs

Two entry points, same modal under the hood:

1. **Pick-list** — `/vehicles/[vin]/pick-list` → **Mark Complete**.
   Used by installers on the shop floor.
2. **In-shop tracking** — `/tracking` → expand row → **Run Completion
   Process**. Used by admins finalizing on behalf of an installer
   without leaving the master tracking view.

Both invoke `CompletionModal` (see
`src/components/CompletionModal.tsx`).

## What the modal asks for

A focused walkthrough — one step at a time:

1. **QC checklist verification** — every required item must be
   checked. Optional items can be left.
2. **Completion photos** — at least one. Multiple encouraged. Photos
   route through the R2 storage helper (Cloudflare R2 public bucket
   for completion-grade photos).
3. **Completion notes** — free-form. Visible to admin / sales / next
   shift.
4. **Confirmation screen** — review what's about to be saved + who's
   notified. Click **Mark Complete** to commit.

## What the gate enforces

`/api/vehicle-tracking/update-status` blocks the
`in_progress → complete` transition unless:

- At least one completion photo exists.
- Every required QC item is checked.
- The linked graphics install lane (if any) is `installed`.

Failure response: 422 with `{ missing: ['completion_photo',
'graphics_install', ...] }`. The modal renders the missing items
inline so the user sees exactly what's blocking.

## What completion fires

On success:

1. Vehicle row in `vehicle_tracking` flips to `complete` with
   `completed_at` + `completed_by`.
2. **Customer notification.** Email always; SMS when
   `SMS_PROVIDER_ENABLED=true`. Comes from the customer-comms
   threading layer so it lands as a message in the right thread.
3. **Shop team notification.** In-app push + email to admins / shop
   leads.
4. **Inbox thread auto-create / reuse.** If the vehicle doesn't have
   a customer thread yet, one is created and tagged
   `entity_type='fleet_checkin'`. The completion message is posted
   there as outbound.
5. **Graphics install lane** — if the vehicle has a linked graphics
   job, it transitions to `installed`. The graphics page surfaces
   this on the install lane column.

## QC checklist — how it gets there

Templates live in `install_checklist_templates`. Three are seeded by
default: **Upfit**, **Graphics**, **Mixed**. Admins manage them at
`/admin/install-checklists`.

When a vehicle goes `received → in_progress` for the first time, the
matching template is cloned into `job_tasks` rows for that vehicle
based on the type of work expected.

Editing a template after a vehicle is in-progress does **not**
re-clone — the running job keeps its original tasks. New jobs pick
up the new template.

## Force-complete (admin override)

When the gate is wrong (e.g. customer waved off a required item, or
the graphics install lane is in some weird state), admins have a
**Force Complete (Admin)** button on the pick-list.

It:
- Skips the gate.
- Records `forced_complete=true`, `forced_by`, `forced_at`, and a
  required-when-forced reason.
- Still fires all the completion side-effects (notifications, thread
  message, etc.).

If you find yourself force-completing more than once a week, the gate
is probably wrong somewhere — ask the engineering team to look at
why.

## Things you'll see on the completed row

After completion, the `/tracking` row shows:

- ✓ green status
- Completion photos in the photo timeline
- Completion notes prominently
- Linked graphics job marked `installed`
- Time spent in `in_progress`
- Who completed it + when

The pick-list page itself stays accessible for retrospective lookup.

## Roles involved

- `installer` — primary actor, does the completion.
- `admin` — can run completion from `/tracking`, force-complete on
  the pick-list.
- `shop_tech` — visibility into the completed row from `/tracking`,
  but doesn't run the completion themselves typically.
- `customer` — receives the completion notification.

## Common issues

**"Mark Complete is disabled / no photo button."** — The
`CompletionModal` had a dark-mode bug where the photo upload button
was invisible. Fixed in commit 2259d52. If you're on an old build,
upgrade.

**"Photo upload returns 404."** — The completion photo path used to
hit Supabase Storage directly. It now routes through the R2 helper.
If you see 404 from Cloudflare, check that the build is up to date.

**"Checklist toggle returns 400."** — `job_tasks` was missing an
`updated_at` trigger that PostgREST relied on; fixed by migration
081. Run that migration on Supabase.
