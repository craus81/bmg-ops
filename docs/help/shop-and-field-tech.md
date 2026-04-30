# Shop tech and field tech guide

The **shop_tech** role is for warehouse / receiving staff. The
**field_tech** role is for service techs out in the field. Both run on
Fleet GO.

Default features (`ROLE_DEFAULT_FEATURES`):
- **shop_tech**: home, scan, fleet check-in, in-shop, time, messages,
  schedule.
- **field_tech**: home, scan, time, messages.

If you do both shop and field work and need a wider surface, ask your
admin for the **installer** role too — your account can carry multiple
roles.

## How do I check in a vehicle?

This is the shop tech's main job — recording arrival.

1. Tap **Check In** in the bottom nav (or `/fleet`).
2. Enter the VIN.
   - Full 17 chars works.
   - Last 8+ chars works too — the app does a partial match against
     prior check-ins and scans. Unique → auto-completes. Multiple →
     picker. None → asks for the full 17.
3. The customer + delivery address pre-fill from the originating
   estimate / Sales Order. Review and override if needed.
4. Take check-in photos — exterior, dash with mileage, any pre-existing
   damage. Tap **Add Photo** for each.
5. Confirm install context. The blue panel shows what came from the
   estimate / customer-default; you can add per-vehicle notes
   (`site_access_notes`) here.
6. Tap **Save Check-In**.

After save you can:
- Tap **Check in another for customer** to keep customer + shared
  context for the next vehicle.
- Tap **Done** to return to the queue.

## How do I clone a recent check-in?

1. On the `/fleet` home, scroll to **Recent Check-Ins**.
2. Tap the **Clone** action on the row you want to copy.
3. The check-in form opens with the customer + context pre-filled. Fill
   in the new VIN.

Useful when the same customer drops off a fleet of similar vehicles in
the same trip.

## How do I look up a vehicle by partial VIN?

The fleet check-in form does this automatically. To do an explicit
lookup outside the form:

1. Tap **Scan** in the bottom nav (or `/scan`).
2. Type the partial VIN into the search bar.
3. The matching scan / check-in rows appear inline.

The lookup endpoint is `/api/fleet/lookup-vin` if you're scripting
against it.

## How do I scan a VIN?

1. Tap **Scan** in the bottom nav (or `/scan`).
2. Tap **Scan VIN**.
3. Point the camera at the VIN barcode (windshield, door jamb, or paper
   registration). Hold steady — orientation locks to portrait while the
   scanner is open.
4. The app decodes via NHTSA. If it can't decode, tap **Enter Manually**
   and type the VIN.
5. Confirm and save.

Each scan creates a `scan_logs` row with the scan time and your user.

## How do I scan a part number / SKU?

1. `/scan` → **Scan Part**.
2. Point at the SKU barcode.
3. The part number is matched against the parts catalog.
   - If matched: the scan logs against an open PO that lists this part
     and decrements expected qty.
   - If unmatched: you'll see a **Not Found** message. Either confirm
     the SKU is right and try again, or escalate to ops to add the part
     to the catalog.

## How do I see what's in the shop right now?

Shop techs have access to **In-Shop Tracking** at `/tracking`. Each row
is a vehicle currently at the shop with its status. Expand to see
context, the photo timeline, and the QC checklist (read-only at this
role).

You can use the **Run Completion Process** button if your shop's
process puts that step on the shop tech rather than the installer —
otherwise it's typically the installer or admin who clicks it.

## How do I see today's schedule?

Shop techs have access to `/admin/schedule`.

1. Tap **Schedule** in the bottom nav.
2. The week view shows scheduled installs, deliveries, and any other
   booked slots.
3. Tap a slot to see the assigned vehicle + installer.

## How do I send a customer comms message?

Shop techs have access to messages but not the unified inbox. The
typical flow:

1. From a vehicle in `/tracking`, tap **Message Customer**.
2. The thread opens with the right scope.
3. Type and send.

Replies go to whoever is assigned in the inbox — that's typically an
admin or sales rep, not the shop tech.

## How do I clock in / out?

1. Tap **Time** in the bottom nav (or `/time`).
2. Tap **Clock In** at start of day.
3. Tap **Start Break** / **End Break** as needed.
4. Tap **Clock Out** at end of day.

Time entries cover both shop and field work — the app doesn't
distinguish. If your shop tracks billable vs. non-billable, that's
handled in your weekly report by your admin.

## How do I check messages?

Tap **Messages** in the bottom nav (or `/messages`).

This is the in-app chat for crew — separate from the customer comms
inbox. Use it to ping a coworker about a vehicle / part / shift.

## What's different between shop_tech and field_tech?

| Feature | shop_tech | field_tech |
| --- | :-: | :-: |
| Home dashboard | ✓ | ✓ |
| VIN / part scan | ✓ | ✓ |
| Fleet check-in | ✓ | — |
| In-shop tracking | ✓ | — |
| Schedule | ✓ | — |
| Time clock | ✓ | ✓ |
| Crew messages | ✓ | ✓ |

Field techs intentionally don't see check-in / in-shop because they're
not at the shop. If you do both, ask for both roles on your profile.

## What if I need to do something my role doesn't allow?

Either:
- Ask an admin to add a feature override on your profile (per-user
  override at **Admin → Users → Feature Overrides**), or
- Ask for a second role (e.g. `installer`) if it's a job-function
  change rather than a one-off.

Don't try to work around a missing tab — if the feature isn't there
for you, the API also blocks it server-side.
