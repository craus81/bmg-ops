import { NextRequest, NextResponse } from 'next/server';
import { requireStaff, isAdminRole } from '@/lib/api-auth';
import { notify, notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { loadChecklistTemplate, buildTaskRows } from '@/lib/install-checklist';
import { appendSoLineTasks } from '@/lib/so-line-tasks';
import { closeShopShiftsForCheckin, followStageWithShopTimer } from '@/lib/shop-labor';
import { isShopStage, vehicleRowKey, type ShopStage } from '@/lib/types';
import { logAudit } from '@/lib/audit';
import { createClient as createServiceClient } from '@supabase/supabase-js';

const serviceSupabase = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Legal transitions for fleet_checkins.status. The one-line status row
// (owner layout 2026-10-02) dropped Stuck (Parts/Graphics) and plain In
// Progress from the buttons: Graphics / Graphics Complete / In Progress
// Upfit / Upfit Complete are shop stages (see handleStageChange) that keep
// status = in_progress. 'in_progress' itself is still accepted for older
// clients, and stuck_* rows left over from before migration 337 can still
// move out. Invoicing still flips received/in_progress/complete directly;
// this state machine only governs the install pipeline.
const LEGAL_TRANSITIONS: Record<string, string[]> = {
  received: ['in_progress', 'complete'],
  in_progress: ['complete', 'received'],
  stuck_parts: ['received', 'in_progress', 'complete'],
  stuck_graphics: ['received', 'in_progress', 'complete'],
  complete: ['shipped', 'in_progress'],
  shipped: ['complete'],
  // legacy value — treat like received
  checked_in: ['in_progress', 'received', 'complete'],
};

const VALID_STATUSES = ['received', 'in_progress', 'complete', 'shipped'];

export async function POST(request: Request) {
  const auth = await requireStaff(request as NextRequest);
  if (auth.error) return auth.error;
  const user = auth.user;

  try {
    const body = await request.json();
    const { vehicleId, newStatus, note, force } = body;

    if (!vehicleId || !newStatus) {
      return NextResponse.json({ error: 'vehicleId and newStatus are required' }, { status: 400 });
    }

    if (!VALID_STATUSES.includes(newStatus) && !isShopStage(newStatus)) {
      return NextResponse.json({ error: 'Invalid status value' }, { status: 400 });
    }

    // Get current vehicle + user profile
    const [vehicleResult, profileResult] = await Promise.all([
      serviceSupabase
        .from('fleet_checkins')
        .select('id, status, vin, customer_name, vehicle_year, vehicle_make, vehicle_model, assigned_to, matched_graphics_job_id, graphics_install_status, qc_completed_at, customer_portal_token, source_estimate_id, shop_stage, upfit_completed_at')
        .eq('id', vehicleId)
        .single(),
      serviceSupabase.from('profiles').select('id, full_name, role, roles').eq('id', user.id).single(),
    ]);

    if (vehicleResult.error || !vehicleResult.data) {
      return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 });
    }

    const vehicle = vehicleResult.data;
    const currentStatus = vehicle.status as string;
    const userName = profileResult.data?.full_name || user.email || 'Unknown';
    // roles[] with a scalar fallback (Round 3, §7.2.6): the force-override
    // used to read the scalar `role` only, so an admin whose grant lives in
    // roles[] couldn't override — the same profileRoles idiom api-auth uses.
    const userRoles: string[] = profileResult.data?.roles?.length
      ? profileResult.data.roles
      : (profileResult.data?.role ? [profileResult.data.role] : []);
    const isAdmin = isAdminRole(userRoles);

    if (isShopStage(newStatus)) {
      return handleStageChange(vehicle, newStatus, note, user.id, userName);
    }

    // No-op: same status
    if (currentStatus === newStatus) {
      return NextResponse.json({ success: true, noop: true, vehicleId, fromStatus: currentStatus, toStatus: newStatus });
    }

    // Transition legality (admin can force). Every gate a force actually
    // bypasses is collected and written to audit_log as one status_forced
    // entry (R4-5) — the exceptions digest reads it weekly.
    const forcedBypasses: string[] = [];
    const allowed = LEGAL_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      if (!(force && isAdmin)) {
        return NextResponse.json({
          error: 'Illegal status transition',
          fromStatus: currentStatus,
          toStatus: newStatus,
          allowed,
        }, { status: 400 });
      }
      forcedBypasses.push(`illegal transition ${currentStatus} → ${newStatus}`);
    }

    // Enforce artifact requirements on EVERY transition into 'complete'.
    // The gate used to run only on in_progress → complete, so received →
    // complete (a legal transition) skipped the whole ceremony: no photos,
    // no required tasks (never instantiated), no graphics-lane check, no QC
    // stamp, no notifications. The one exception is shipped → complete —
    // that's an un-ship bookkeeping correction on a vehicle that already
    // completed, not a new completion.
    const isCompleting = newStatus === 'complete' && currentStatus !== 'shipped';
    if (isCompleting) {
      // A vehicle completed straight from 'received' never had its checklist
      // instantiated — required tasks would pass vacuously. Instantiate on
      // demand (no-op when tasks already exist) so the gate has teeth.
      await instantiateChecklist(vehicleId, !!vehicle.matched_graphics_job_id);

      const [photoResult, taskResult] = await Promise.all([
        serviceSupabase
          .from('vehicle_photos')
          .select('id', { count: 'exact', head: true })
          .eq('vehicle_id', vehicleId)
          .eq('photo_type', 'completion'),
        serviceSupabase
          .from('job_tasks')
          .select('id, label, completed, required')
          .eq('job_type', 'fleet_checkin')
          .eq('job_id', vehicleId)
          .eq('required', true),
      ]);

      const photoCount = photoResult.count || 0;
      const unfinished = (taskResult.data || []).filter((t: any) => !t.completed);

      const missing: string[] = [];
      if (photoCount === 0) missing.push('Upload at least one completion photo');
      for (const t of unfinished) missing.push(`Required task: ${t.label}`);

      // Graphics lane gate: when a graphics job is linked, the vehicle's
      // graphics install lane (migration 085) must also be done before the
      // completion ceremony fires. Standalone-upfit vehicles backfilled to
      // 'n/a' pass automatically. See /api/vehicle-tracking/graphics-install-status.
      const graphicsLane = (vehicle as any).graphics_install_status || 'pending';
      const hasGraphicsJob = !!(vehicle as any).matched_graphics_job_id;
      if (hasGraphicsJob && graphicsLane !== 'complete' && graphicsLane !== 'n/a') {
        missing.push(`Graphics install lane is "${graphicsLane}" — mark complete (or N/A) first`);
      }

      if (missing.length > 0) {
        if (!(force && isAdmin)) {
          return NextResponse.json({
            error: 'Completion requirements not met',
            missing,
          }, { status: 422 });
        }
        forcedBypasses.push(...missing);
      }
    }

    // Build update payload. QC stamps apply to every real completion, but
    // never overwrite an earlier stamp (shipped → complete re-entry, or a
    // second completion after in_progress rework keeps the original).
    // A shop stage only means something while in_progress; Received /
    // Complete / Shipped clear it (the Graphics Complete and Upfit Complete
    // checks live in their own columns and stay).
    const updatePayload: Record<string, any> = { status: newStatus, shop_stage: null };
    if (isCompleting) {
      if (!(vehicle as any).qc_completed_at) {
        updatePayload.qc_completed_at = new Date().toISOString();
        updatePayload.qc_completed_by = user.id;
      }
      if (note?.trim()) updatePayload.completion_notes = note.trim();
    }

    const { error: updateError } = await serviceSupabase
      .from('fleet_checkins')
      .update(updatePayload)
      .eq('id', vehicleId);

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update status: ' + updateError.message }, { status: 500 });
    }

    // Log status change
    await serviceSupabase.from('vehicle_status_history').insert({
      vehicle_id: vehicleId,
      from_status: currentStatus,
      to_status: newStatus,
      note: note?.trim() || null,
      changed_by: user.id,
      changed_by_name: userName,
    });

    // Audit an admin force only when it actually bypassed a gate — forcing a
    // transition that was legal anyway is not an exception.
    if (forcedBypasses.length > 0) {
      await logAudit(serviceSupabase, {
        actorId: user.id,
        table: 'fleet_checkins',
        recordId: vehicleId,
        action: 'status_forced',
        detail: { from: currentStatus, to: newStatus, bypassed: forcedBypasses },
      });
    }

    // Shop job timer (owner rules 2026-10-02): finishing the completion
    // procedure stops it, and so does shipping.
    if (newStatus === 'complete' || newStatus === 'shipped') {
      try {
        await closeShopShiftsForCheckin(serviceSupabase, vehicleId);
      } catch (err) {
        console.warn('update-status: shop shift auto-close failed:', err);
      }
    }

    // On received → in_progress, instantiate a checklist from the default
    // template if one doesn't already exist for this vehicle.
    if (currentStatus === 'received' && newStatus === 'in_progress') {
      await instantiateChecklist(vehicleId, !!vehicle.matched_graphics_job_id);
    }

    // On any real completion, fire notifications (shipped → complete is a
    // bookkeeping correction — the customer was already told).
    if (isCompleting) {
      // Don't block the response on notifications
      notifyCompletion(vehicle, userName).catch((err) => {
        console.error('notifyCompletion error:', err);
      });
    }

    // Shipped only marks the vehicle as off the lot (owner decision
    // 2026-10-02): customers pick up or BMG drops off, so nobody gets a
    // push, a bell alert or a customer email. It still shows up as one line
    // in the afternoon staff digest email.
    if (newStatus === 'shipped') {
      noteShippedInDigest(vehicle).catch((err) => {
        console.error('noteShippedInDigest error:', err);
      });
    }

    return NextResponse.json({
      success: true,
      vehicleId,
      fromStatus: currentStatus,
      toStatus: newStatus,
    });
  } catch (err: any) {
    console.error('Vehicle tracking update error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * One-line status buttons Graphics / Graphics Complete / In Progress Upfit /
 * Upfit Complete (owner layout 2026-10-02 — no forced order). Each one puts
 * the vehicle in_progress with that shop_stage, and:
 *   - Graphics opens the graphics install lane (clearing its done check);
 *   - Graphics Complete completes the lane (the migration-085 trigger flips
 *     the linked graphics job to installed), and the check stays;
 *   - In Progress Upfit clears the Upfit Complete check;
 *   - Upfit Complete stamps upfit_completed_at, and the check stays.
 * History gets one row, row-key to row-key, so the timeline and the "in
 * stage since" chips follow the row. A running shop timer follows the
 * stage (followStageWithShopTimer).
 */
async function handleStageChange(
  vehicle: any,
  stage: ShopStage,
  note: string | null | undefined,
  userId: string,
  userName: string,
) {
  const currentStatus = vehicle.status as string;
  if (currentStatus === 'shipped') {
    return NextResponse.json({ error: 'This vehicle is marked Shipped. Move it back to Complete first.' }, { status: 400 });
  }
  const fromKey = vehicleRowKey(vehicle);
  if (fromKey === stage) {
    return NextResponse.json({ success: true, noop: true, vehicleId: vehicle.id, fromStatus: fromKey, toStatus: stage });
  }

  const now = new Date().toISOString();
  const lane = vehicle.graphics_install_status || 'pending';
  const updatePayload: Record<string, any> = { status: 'in_progress', shop_stage: stage };
  if (stage === 'graphics' && lane !== 'in_progress') {
    updatePayload.graphics_install_status = 'in_progress';
    updatePayload.graphics_install_completed_at = null;
    updatePayload.graphics_install_completed_by = null;
  } else if (stage === 'graphics_complete' && lane !== 'complete') {
    updatePayload.graphics_install_status = 'complete';
    updatePayload.graphics_install_completed_at = now;
    updatePayload.graphics_install_completed_by = userId;
  } else if (stage === 'upfit' && vehicle.upfit_completed_at) {
    updatePayload.upfit_completed_at = null;
    updatePayload.upfit_completed_by = null;
  } else if (stage === 'upfit_complete' && !vehicle.upfit_completed_at) {
    updatePayload.upfit_completed_at = now;
    updatePayload.upfit_completed_by = userId;
  }

  const { error: updateError } = await serviceSupabase
    .from('fleet_checkins')
    .update(updatePayload)
    .eq('id', vehicle.id);
  if (updateError) {
    return NextResponse.json({ error: 'Failed to update status: ' + updateError.message }, { status: 500 });
  }

  await serviceSupabase.from('vehicle_status_history').insert({
    vehicle_id: vehicle.id,
    from_status: fromKey,
    to_status: stage,
    note: note?.trim() || null,
    changed_by: userId,
    changed_by_name: userName,
  });

  // Starting work on a freshly received vehicle: same checklist the old
  // Received → In Progress move instantiated.
  if (currentStatus === 'received' || currentStatus === 'checked_in') {
    await instantiateChecklist(vehicle.id, !!vehicle.matched_graphics_job_id);
  }

  try {
    await followStageWithShopTimer(serviceSupabase, vehicle.id, stage);
  } catch (err) {
    console.warn('update-status: shop timer follow failed:', err);
  }

  return NextResponse.json({ success: true, vehicleId: vehicle.id, fromStatus: fromKey, toStatus: stage });
}

async function instantiateChecklist(vehicleId: string, hasGraphics: boolean) {
  try {
    // Skip if already instantiated
    const { count } = await serviceSupabase
      .from('job_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('job_type', 'fleet_checkin')
      .eq('job_id', vehicleId);
    if (count && count > 0) return;

    // Simple category heuristic — future work can extend this based on
    // matched PO line items vs graphics jobs. The shared helper tries the
    // exact category first and falls back to 'mixed' (the old single-query
    // ordering trick returned the mixed template for upfit-only vehicles,
    // blocking their completion on a required graphics task).
    const preferredCategory = hasGraphics ? 'mixed' : 'upfit';
    const template = await loadChecklistTemplate(serviceSupabase, preferredCategory);
    if (!template) return;

    const rows = buildTaskRows(template, vehicleId);
    if (rows.length > 0) {
      await serviceSupabase.from('job_tasks').insert(rows);
    }

    // R6-10: the template says how to work safely and what to verify. It
    // cannot say what to INSTALL — that's whatever the customer bought.
    // Append one task per stockable line on the linked sales order.
    await appendSoLineTasks(serviceSupabase, vehicleId, rows.length);
  } catch (err) {
    console.error('instantiateChecklist error:', err);
  }
}

/**
 * Who hears about a vehicle finishing or shipping: the people on it — the
 * vehicle's assignee, anyone assigned to it, and the sales rep (the source
 * estimate's creator, same rule as the pickup nudges). The admins are only
 * the fallback when nobody is on the vehicle, so somebody is always on the
 * hook without every admin getting every vehicle. This used to go to ALL
 * admins, twice on complete and again on shipped — ~3 emails per admin per
 * vehicle, which is what ran Resend's daily cap out (2026-09-28).
 */
async function vehicleAlertTargets(vehicle: any): Promise<string[]> {
  const targets = new Set<string>();
  if (vehicle.assigned_to) targets.add(vehicle.assigned_to);
  const [assignmentsRes, estimateRes] = await Promise.all([
    serviceSupabase
      .from('job_assignments')
      .select('user_id')
      .eq('job_type', 'scanned_vehicle')
      .eq('job_id', vehicle.id),
    vehicle.source_estimate_id
      ? serviceSupabase.from('estimates').select('created_by').eq('id', vehicle.source_estimate_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  for (const a of assignmentsRes.data || []) if (a.user_id) targets.add(a.user_id);
  const repId = (estimateRes.data as any)?.created_by;
  if (repId) targets.add(repId);
  if (targets.size > 0) return [...targets];

  const { data: admins } = await serviceSupabase
    .from('profiles').select('id')
    .or('role.in.(admin,super_admin),roles.cs.{admin},roles.cs.{super_admin}')
    .eq('status', 'approved');
  return (admins || []).map((a: any) => String(a.id));
}

function vehicleLabelOf(vehicle: any): string {
  return [vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model]
    .filter(Boolean)
    .join(' ') || `VIN ${vehicle.vin?.slice(-8) || ''}`;
}

/**
 * ONE alert per completion. It used to be two — "Install complete" plus a
 * separate "Tell <customer>" prompt — so it now carries both jobs: the news,
 * and (when there's a customer) the prompt to send the email.
 *
 * The customer is NOT emailed here. This used to send "your vehicle is
 * ready" (with the booking link and the review ask) the instant anyone
 * moved the status — owner decision 2026-09-14 made every customer-facing
 * send a person's decision. So the alert's job is to get the email sent
 * from the vehicle's Email Customer button
 * (/api/vehicle-tracking/notify-customer, kind 'ready' — the same content,
 * review ask included, now with a preview and editable recipients).
 */
async function notifyCompletion(vehicle: any, actorName: string) {
  const vehicleLabel = vehicleLabelOf(vehicle);
  const targets = await vehicleAlertTargets(vehicle);
  if (targets.length === 0) return;

  const hasCustomer = !!vehicle.customer_name;
  await notifyMany(targets, {
    type: 'vehicle_complete',
    title: hasCustomer
      ? `Install complete: ${vehicleLabel} — tell ${vehicle.customer_name}`
      : `Install complete: ${vehicleLabel}`,
    body: `${actorName} marked ${vehicleLabel}${hasCustomer ? ` (${vehicle.customer_name})` : ''} complete. VIN ${vehicle.vin}.`
      + (hasCustomer
        ? ' Nothing has gone to the customer: open the vehicle and use Email Customer to send them the pickup booking link.'
        : ''),
    url: deepLinks.vehicle(vehicle.id),
  });
}

/**
 * A digest line, nothing more, when a vehicle leaves the lot. Email is the
 * only channel, and vehicle_complete isn't an emailNow type, so it queues
 * for the afternoon "Today's alerts" email: no push, no bell alert, and
 * nothing for anyone who turned email off for this alert.
 */
async function noteShippedInDigest(vehicle: any) {
  const vehicleLabel = vehicleLabelOf(vehicle);
  const targets = await vehicleAlertTargets(vehicle);
  if (targets.length === 0) return;
  await notifyMany(targets, {
    type: 'vehicle_complete',
    channels: ['email'],
    title: `Shipped: ${vehicleLabel}`,
    body: `${vehicleLabel}${vehicle.customer_name ? ` (${vehicle.customer_name})` : ''} left the lot. VIN ${vehicle.vin}.`,
    url: deepLinks.vehicle(vehicle.id),
  });
}
