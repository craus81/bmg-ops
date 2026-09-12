import { NextRequest, NextResponse } from 'next/server';
import { requireStaff, isAdminRole } from '@/lib/api-auth';
import { notify, notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { loadChecklistTemplate, buildTaskRows } from '@/lib/install-checklist';
import { appendSoLineTasks } from '@/lib/so-line-tasks';
import { closeShopShiftsForCheckin } from '@/lib/shop-labor';
import { logAudit } from '@/lib/audit';
import { createClient as createServiceClient } from '@supabase/supabase-js';

const serviceSupabase = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Legal transitions for fleet_checkins.status. stuck_parts/stuck_graphics are
// side-branches reachable from/to any live state. Invoicing still flips
// received/in_progress/complete directly; this state machine only governs the
// install pipeline.
const LEGAL_TRANSITIONS: Record<string, string[]> = {
  received: ['in_progress', 'stuck_parts', 'stuck_graphics', 'complete'],
  in_progress: ['complete', 'stuck_parts', 'stuck_graphics', 'received'],
  stuck_parts: ['received', 'in_progress', 'stuck_graphics'],
  stuck_graphics: ['received', 'in_progress', 'stuck_parts'],
  complete: ['shipped', 'in_progress'],
  shipped: ['complete'],
  // legacy value — treat like received
  checked_in: ['in_progress', 'stuck_parts', 'stuck_graphics', 'received', 'complete'],
};

const VALID_STATUSES = ['received', 'in_progress', 'stuck_parts', 'stuck_graphics', 'complete', 'shipped'];

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

    if (!VALID_STATUSES.includes(newStatus)) {
      return NextResponse.json({ error: 'Invalid status value' }, { status: 400 });
    }

    // Get current vehicle + user profile
    const [vehicleResult, profileResult] = await Promise.all([
      serviceSupabase
        .from('fleet_checkins')
        .select('id, status, vin, customer_name, vehicle_year, vehicle_make, vehicle_model, assigned_to, matched_graphics_job_id, graphics_install_status, qc_completed_at, customer_portal_token')
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
    const updatePayload: Record<string, any> = { status: newStatus };
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

    // R3-21: a pick-list labor timer nobody stopped ends when the vehicle
    // does — completing or shipping closes any open shop shift, flagged
    // auto_closed so the margin report shows those hours as approximate.
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
      notifyCompletion(vehicle, userName, user.email || null).catch((err) => {
        console.error('notifyCompletion error:', err);
      });
    }

    // On → shipped, tell the customer their vehicle left the shop —
    // "where is my vehicle?" answered before it's asked.
    if (newStatus === 'shipped') {
      notifyShipped(vehicle, user.email || null).catch((err) => {
        console.error('notifyShipped error:', err);
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

async function notifyCompletion(vehicle: any, actorName: string, actorEmail: string | null) {
  const vehicleLabel = [vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model]
    .filter(Boolean)
    .join(' ') || `VIN ${vehicle.vin?.slice(-8) || ''}`;
  const customerName = vehicle.customer_name || 'customer';

  // Shop team: admins + any assigned installers
  const targetUserIds = new Set<string>();
  const [adminsRes, assignmentsRes] = await Promise.all([
    serviceSupabase.from('profiles').select('id').in('role', ['admin', 'super_admin']).eq('status', 'approved'),
    serviceSupabase
      .from('job_assignments')
      .select('user_id')
      .eq('job_type', 'scanned_vehicle')
      .eq('job_id', vehicle.id),
  ]);
  for (const a of adminsRes.data || []) targetUserIds.add(a.id);
  for (const a of assignmentsRes.data || []) targetUserIds.add(a.user_id);
  if (vehicle.assigned_to) targetUserIds.add(vehicle.assigned_to);

  if (targetUserIds.size > 0) {
    await notifyMany(Array.from(targetUserIds), {
      type: 'vehicle_complete',
      title: `Install complete: ${vehicleLabel}`,
      body: `${actorName} marked ${vehicleLabel} (${customerName}) complete. VIN ${vehicle.vin}.`,
      url: deepLinks.pickList(vehicle.vin, vehicle.id),
    });
  }

  // Customer: shared resolver (customers-by-name → primary contact →
  // thread → email + SMS), honoring the customer's status-email opt-out.
  if (!vehicle.customer_name) return;
  const { notifyCustomerByName } = await import('@/lib/customer-notify');
  const { buildNotificationEmail } = await import('@/lib/resend');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  // Customer CTA (R5-17): the tokenized booking page — the customer picks
  // a pickup slot instead of playing phone tag ("contact us to arrange
  // pickup" was the whole flow). Every check-in has a portal token
  // (auto-minted since migration 001); fall back to the portal dashboard
  // only if a legacy row somehow lacks one — never a dead click.
  const bookUrl = vehicle.customer_portal_token
    ? `${appUrl}/book/${vehicle.customer_portal_token}`
    : `${appUrl}${deepLinks.customerPortal()}`;
  const emailBody = vehicle.customer_portal_token
    ? `The install for your ${vehicleLabel} (VIN ending ${vehicle.vin?.slice(-8)}) is complete. Book a pickup time online — or reply to this email if another arrangement works better.`
    : `The install for your ${vehicleLabel} (VIN ending ${vehicle.vin?.slice(-8)}) is complete. Please contact us to arrange pickup.`;
  // R6-13: a "How did we do?" block rides along, but only when it is
  // reasonable to ask — see src/lib/review-request.ts for the four reasons
  // not to. The decision is made BEFORE the send and the suppression stamp
  // is written after, so a failed email cannot silence six months of asks.
  const review = await maybeReviewBlock(vehicle.customer_name);
  const result = await notifyCustomerByName(serviceSupabase, vehicle.customer_name, {
    contextEntityType: 'fleet_checkin',
    contextEntityId: vehicle.id,
    threadSubject: `${vehicleLabel} ready for pickup`,
    emailSubject: `[BMG Fleet] Your vehicle is ready — ${vehicleLabel}`,
    emailHtml: buildNotificationEmail(`Your vehicle is ready — ${vehicleLabel}`, emailBody, bookUrl, vehicle.customer_portal_token ? 'Book your pickup time' : 'View order status')
      + (review?.html || ''),
    messageBody: emailBody,
    smsBody: `[BMG Fleet] Your ${vehicleLabel} is ready for pickup. Book a time: ${bookUrl}`,
    replyTo: actorEmail,
  });
  if (review && result?.emailed) {
    const { stampReviewAsk } = await import('@/lib/review-request');
    await stampReviewAsk(serviceSupabase, review.customerId);
  }
}

/**
 * The review block for this customer, or null when we should not ask.
 * Resolves the customers row by name the same way notifyCustomerByName
 * does, so the two agree on who is being emailed.
 */
async function maybeReviewBlock(customerName: string): Promise<{ html: string; customerId: string } | null> {
  try {
    const { data: customer } = await serviceSupabase
      .from('customers')
      .select('id')
      .ilike('company_name', customerName)
      .maybeSingle();
    if (!customer?.id) return null;
    const { decideReviewAsk, reviewBlockHtml } = await import('@/lib/review-request');
    const decision = await decideReviewAsk(serviceSupabase, customer.id);
    if (!decision.ask || !decision.url) return null;
    return { html: reviewBlockHtml(decision.url), customerId: customer.id };
  } catch (e: any) {
    // Any failure here means we do NOT ask. Skipping an ask costs nothing;
    // asking an unhappy customer for a public review costs a star.
    console.error('review-request decision failed:', e?.message);
    return null;
  }
}

/** Customer email when their vehicle leaves the shop. */
async function notifyShipped(vehicle: any, actorEmail: string | null) {
  if (!vehicle.customer_name) return;
  const vehicleLabel = [vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model]
    .filter(Boolean)
    .join(' ') || `VIN ${vehicle.vin?.slice(-8) || ''}`;
  const { notifyCustomerByName } = await import('@/lib/customer-notify');
  const { buildNotificationEmail } = await import('@/lib/resend');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  // Customer CTA → portal dashboard (see notifyCompletion) — the shipped
  // email previously had no button at all.
  const portalUrl = `${appUrl}${deepLinks.customerPortal()}`;
  const emailBody = `Your ${vehicleLabel} (VIN ending ${vehicle.vin?.slice(-8)}) has left our facility. Reply to this email with any questions.`;
  const review = await maybeReviewBlock(vehicle.customer_name);
  const result = await notifyCustomerByName(serviceSupabase, vehicle.customer_name, {
    contextEntityType: 'fleet_checkin',
    contextEntityId: vehicle.id,
    threadSubject: `${vehicleLabel} shipped`,
    emailSubject: `[BMG Fleet] Your vehicle has shipped — ${vehicleLabel}`,
    emailHtml: buildNotificationEmail(`On its way — ${vehicleLabel}`, emailBody, portalUrl, 'View order status')
      + (review?.html || ''),
    messageBody: emailBody,
    replyTo: actorEmail,
  });
  if (review && result?.emailed) {
    const { stampReviewAsk } = await import('@/lib/review-request');
    await stampReviewAsk(serviceSupabase, review.customerId);
  }
}
