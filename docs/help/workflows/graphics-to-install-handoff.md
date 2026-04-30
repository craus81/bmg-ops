# Workflow: graphics → install handoff

End-to-end flow from "graphics finished a job" to "vehicle is fully
complete and the customer has been notified." Touches graphics
production, installers, and admins.

## Sequence

1. **Graphics marks job ready.** `graphics_production` user opens
   the job at `/graphics/[id]` and flips status to `ready` from the
   status chip.
2. **Targeted notification fires.** `/api/graphics/notify-ready` sends
   a notification to:
   - Installers assigned to the matching vehicle.
   - Admins.
   - Anyone opted in via the **Notify me when ready for install**
     toggle in their settings.
   It does **not** spray everyone with the legacy `notify_ready=true`
   flag.
3. **Installer schedules the install.** Recipient opens
   `/installer/ready-for-install`, finds the row, taps **Schedule**,
   picks a slot. The slot pushes to the shop's Google Calendar (if
   integrated) and assigns the job.
4. **Day-of: installer opens the pick-list.** From the queue or by
   scanning the VIN, installer lands on
   `/vehicles/[vin]/pick-list`. The pick-list shows the matched
   graphics job, the customer-approved proof, every design file,
   install context, and the QC checklist.
5. **Vehicle moves into the shop.** Shop tech does the check-in at
   `/fleet` — the vehicle row in `/tracking` shows up as `received`.
6. **Installer starts work.** First time the installer toggles a
   checklist task or uploads a photo, the vehicle status flips
   `received → in_progress` and the install checklist template is
   cloned into `job_tasks` rows for that vehicle.
7. **Installer completes work.** Required QC items checked, completion
   photos uploaded, completion notes written.
8. **Mark complete.** Installer taps **Mark Complete** on the
   pick-list. `/api/vehicle-tracking/update-status` runs the gate:
   - At least one completion photo? ✓
   - All required QC items checked? ✓
   - Linked graphics install lane done? ✓
   If anything is missing, returns 422 with the missing list.
9. **Completion ceremony fires.** On success:
   - Vehicle flips to `complete`.
   - Customer notification (email + SMS-when-enabled).
   - Shop team in-app + email notification.
   - Auto-creates a customer thread (if not already there) and posts
     the completion message to it for inbox visibility.

## What hard-blocks completion

The `update-status` endpoint enforces all three. Even an admin
clicking **Mark Complete** from `/tracking → Run Completion Process`
hits the same gate.

To bypass legitimately, admins use **Force Complete (Admin)** on the
pick-list. That records who forced and (if you typed a reason) why,
in the audit trail.

## What if the graphics aren't actually ready?

If the installer opens the pick-list and the proofs / files don't
match what's on the vehicle, the right move is:
1. Don't toggle `received → in_progress`.
2. Use **Message Customer** or `/admin/inbox` to ping graphics or sales
   about the discrepancy.
3. Let graphics flip the job back to `revision` if a new proof is
   needed.

## What if there's no matching graphics job?

Some upfit-only vehicles don't have graphics work. The completion gate
allows that — the "graphics install lane done" check is skipped if
there's no linked graphics job.

## How is the linkage tracked?

- `graphics_jobs.upfit_project_id` (FK) links a graphics job to its
  parent upfit project.
- `vehicle_proofs` is the join from a vehicle to graphics proofs.
- `fleet_checkins.netsuite_so_id` links a vehicle to its Sales Order,
  which links to the originating estimate.

The pick-list reconciles all of these to find "the graphics job for
this vehicle" — usually unambiguous, occasionally ambiguous when a
vehicle has multiple upfit + graphics jobs in flight.

## Roles involved

- `graphics_production` — flips job to `ready` and `installed`.
- `shop_tech` — does check-in.
- `installer` — runs the pick-list and marks complete.
- `admin` — can intervene at any point and force-complete.
