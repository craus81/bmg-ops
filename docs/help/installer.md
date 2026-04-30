# Installer guide (Fleet GO)

The **installer** role is mobile-first. The header shows **Fleet GO** +
"Crew". Default features:
home, scan, time, messages, CNI management.

You're typically working from a phone or tablet on the shop floor. Most
of the day flows through a small set of pages: **Ready for Install →
Pick-list → Mark Complete**, plus the **Time** clock and CNI jobs queue
for off-site work.

If your shop has assigned you the broader installer-admin role, you
also see check-in and in-shop tracking — see `shop-and-field-tech.md`
for those.

## How do I see what vehicles are ready for me to install?

1. Tap **CNI Jobs** (or **Ready for Install**) in the bottom nav, or go
   to `/installer/ready-for-install`.
2. The list shows vehicles whose graphics are ready for install,
   filtered to **Mine** by default.
3. Tap **All** to see the whole queue across the shop.
4. Stale rows (> 7 days waiting) are highlighted so they don't fall
   through the cracks.

Tap a row to open its pick-list.

## How do I schedule an install?

From the ready-for-install queue you can schedule inline:

1. Tap a row → **Schedule**.
2. Pick a date / time slot.
3. Confirm.

This pushes the slot to your shop's Google Calendar (if your shop has
that integration enabled) and assigns the job to you.

## How do I check in a vehicle? (if your role allows it)

If you have the `fleet_checkin` feature, you can do check-ins from the
crew app. Otherwise this is the shop tech's job — see
`shop-and-field-tech.md`.

1. Tap **Check In** in the bottom nav (or `/fleet`).
2. Enter the VIN — full 17 chars or the last 8.
3. If partial: unique → auto-completes. Multiple → picker appears.
   None → enter the full VIN.
4. Take check-in photos (exterior, dash, condition).
5. Confirm customer + delivery instructions.
6. Tap **Save Check-In**.
7. To do another for the same customer, tap **Check in another for
   customer** to keep shared context.

## How do I open a pick-list?

1. From the ready-for-install queue, tap a row.
2. Or scan the VIN (`/scan`) — if there's an active job for that VIN,
   you'll see a **Go to Pick-List** button on the result.
3. Or visit `/vehicles/[vin]/pick-list` directly.

The pick-list is the source of truth for everything you need on a
single vehicle.

## What's on the pick-list?

Top to bottom:
- **Install context** — blue panel with site info, contact, and any
  special instructions. Click-to-call works on the contact phone.
- **Matched graphics job** — links to `/graphics/[id]` and shows the
  customer-approved proof + every design file inline.
- **SO memo** — the install instructions copied over from the NetSuite
  Sales Order.
- **Photo timeline** — check-in photos, graphics proofs, design files,
  and any completion photos so far. Filter chips group by category.
- **QC checklist** — every required and optional task. Tap to toggle.
  Required items hard-block completion until done.
- **Completion photo capture** — required upload before mark complete.
- **Completion notes** — free-form notes for the office.
- **Mark Complete** button at the bottom.
- **Message Customer** button (sends to a vehicle-scoped thread).

## How do I check off a QC checklist task?

1. Tap a task row in the **QC Checklist** section.
2. The checkbox toggles immediately.
3. Required items are marked with a red asterisk.

Tasks save server-side with a debounce (no save button). If you see a
red error toast, your changes didn't go through — usually a 400 means
your network dropped; pull-to-refresh and try again.

## How do I take a completion photo?

1. Scroll to the **Completion Photos** section on the pick-list.
2. Tap **Add Photo**.
3. Camera opens (or photo library, depending on your device).
4. Snap or pick a photo.
5. (Optional) Add a caption.
6. Save.

You need at least one completion photo before **Mark Complete** is
allowed. Photos go to Cloudflare R2 storage via the app's R2 helper.

## How do I add notes about the completion?

1. **Completion Notes** field above the **Mark Complete** button.
2. Type your note (anything from "left turn-signal LED replaced" to
   "customer requested holding for invoice review").
3. Tap **Save** (or just leave the field — it auto-saves on blur).

Notes are visible to admins on `/tracking` and to anyone with access
to that vehicle.

## How do I mark a vehicle complete?

1. Verify all required QC items are checked.
2. Verify at least one completion photo is uploaded.
3. Verify the linked graphics job is in a status that allows install
   completion (`installed` or admin override).
4. Tap **Mark Complete**.
5. Confirm in the modal.

If anything's missing the API returns 422 with a `missing` array. The
modal shows which item is blocking — fix it and try again.

On success:
- The vehicle flips to `complete` status.
- Shop team gets in-app + email notification.
- Customer gets email (and SMS when `SMS_PROVIDER_ENABLED=true`).
- The completion ceremony is recorded with timestamps + actor.

## What if I can't mark complete because of something out of my control?

E.g. customer asked you to leave a checklist item undone, or the
graphics aren't quite right but the customer insists.

Ask an admin. Admins have a **Force Complete (Admin)** button on the
pick-list that skips the checks but records who forced it and why.
Don't try to work around the checks — they exist so we can defend the
work later.

## How do I message the customer about a vehicle I'm working on?

1. Pick-list → **💬 Message Customer**.
2. The thread opens in the inbox scoped to that vehicle's check-in.
3. Type and send.

Office staff can see and reply from `/admin/inbox`. Useful for
photo updates, ETA confirmations, or asking about discrepancies.

## How do I clock in / out and take breaks?

1. Tap **Time** in the bottom nav (or `/time`).
2. Tap **Clock In** at the start of your day.
3. Tap **Start Break** when you take a break, **End Break** to resume.
4. Tap **Clock Out** at end of day.

The time clock widget tracks your weekly hours and OT. You can
backdate or edit a missed punch from the entries table — check with
your shop admin first if your shop requires manager approval for
edits.

## How do I work CNI jobs?

CNI ("Customer-Not-Included") jobs are upfits where a customer ships
the vehicle to BMG, billed at the end.

1. Tap **CNI Jobs** in the bottom nav (or `/installer`).
2. Pick a job from the list (assigned to you, or **All**).
3. The job page shows: assigned vehicles, parts list, customer notes,
   files, and a chat/thread with office staff.
4. Update status as you progress (received → in_progress → complete).
5. Take photos throughout — they go to the unified photo timeline.

If you see a job assigned to "Available" rather than to you, you can
claim it from `/installer/available`.

## How do I see my profile / preferences?

1. Tap **Installer → Profile** in the bottom nav (or `/installer/profile`).
2. Edit name, phone, certifications, equipment list.
3. Save.

This profile is what office staff see when assigning jobs to you.

## How do I scan a part number that arrived?

1. Tap **Scan** in the bottom nav (or `/scan`).
2. Tap **Scan Part** to open the camera.
3. Point at the SKU barcode on the part / box.
4. The scan logs against the matching PO and decrements expected
   quantity.

If the part isn't recognized, tap **Add to Catalog** to create the
catalog entry — that requires `parts_catalog` access, which not all
installers have.

## How do I report a problem with a vehicle / job?

The simplest path is to use **Message Customer** for customer-visible
issues, or `/admin/inbox` to ping office staff directly. For
infrastructure problems (the app is broken / the camera won't open),
tap **AI** to ask the FleetSuite AI for a quick fix or escalate to
your admin.

The pick-list also has an **Issues** photo category — tag photos that
document a problem there so they show up under the **Issues** chip on
the timeline.
