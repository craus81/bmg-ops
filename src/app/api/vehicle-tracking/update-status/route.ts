import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { notify, notifyMany } from '@/lib/notify';
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
  const auth = await requireAuth(request as NextRequest);
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
        .select('id, status, vin, customer_name, vehicle_year, vehicle_make, vehicle_model, assigned_to, matched_graphics_job_id')
        .eq('id', vehicleId)
        .single(),
      serviceSupabase.from('profiles').select('id, full_name, role').eq('id', user.id).single(),
    ]);

    if (vehicleResult.error || !vehicleResult.data) {
      return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 });
    }

    const vehicle = vehicleResult.data;
    const currentStatus = vehicle.status as string;
    const userName = profileResult.data?.full_name || user.email || 'Unknown';
    const isAdmin = profileResult.data?.role === 'admin';

    // No-op: same status
    if (currentStatus === newStatus) {
      return NextResponse.json({ success: true, noop: true, vehicleId, fromStatus: currentStatus, toStatus: newStatus });
    }

    // Transition legality (admin can force)
    const allowed = LEGAL_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus) && !(force && isAdmin)) {
      return NextResponse.json({
        error: 'Illegal status transition',
        fromStatus: currentStatus,
        toStatus: newStatus,
        allowed,
      }, { status: 400 });
    }

    // Enforce artifact requirements on in_progress → complete
    if (currentStatus === 'in_progress' && newStatus === 'complete') {
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

      if (missing.length > 0 && !(force && isAdmin)) {
        return NextResponse.json({
          error: 'Completion requirements not met',
          missing,
        }, { status: 422 });
      }
    }

    // Build update payload
    const updatePayload: Record<string, any> = { status: newStatus };
    if (currentStatus === 'in_progress' && newStatus === 'complete') {
      updatePayload.qc_completed_at = new Date().toISOString();
      updatePayload.qc_completed_by = user.id;
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

    // On received → in_progress, instantiate a checklist from the default
    // template if one doesn't already exist for this vehicle.
    if (currentStatus === 'received' && newStatus === 'in_progress') {
      await instantiateChecklist(vehicleId, !!vehicle.matched_graphics_job_id);
    }

    // On in_progress → complete, fire notifications.
    if (currentStatus === 'in_progress' && newStatus === 'complete') {
      // Don't block the response on notifications
      notifyCompletion(vehicle, userName).catch((err) => {
        console.error('notifyCompletion error:', err);
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
    // matched PO line items vs graphics jobs.
    const preferredCategory = hasGraphics ? 'mixed' : 'upfit';
    const { data: template } = await serviceSupabase
      .from('install_checklist_templates')
      .select('id, items, install_category')
      .eq('is_active', true)
      .in('install_category', [preferredCategory, 'mixed'])
      .order('install_category', { ascending: preferredCategory !== 'mixed' })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!template?.items || !Array.isArray(template.items)) return;

    const rows = (template.items as Array<{ label: string; required?: boolean; key?: string }>)
      .filter((i) => i?.label)
      .map((item, i) => ({
        job_type: 'fleet_checkin',
        job_id: vehicleId,
        label: item.label,
        required: item.required === true,
        sort_order: i,
        template_id: template.id,
        task_key: item.key || null,
      }));

    if (rows.length > 0) {
      await serviceSupabase.from('job_tasks').insert(rows);
    }
  } catch (err) {
    console.error('instantiateChecklist error:', err);
  }
}

async function notifyCompletion(vehicle: any, actorName: string) {
  const vehicleLabel = [vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model]
    .filter(Boolean)
    .join(' ') || `VIN ${vehicle.vin?.slice(-8) || ''}`;
  const customerName = vehicle.customer_name || 'customer';

  // Shop team: admins + any assigned installers
  const targetUserIds = new Set<string>();
  const [adminsRes, assignmentsRes] = await Promise.all([
    serviceSupabase.from('profiles').select('id').eq('role', 'admin').eq('status', 'approved'),
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
      url: `/vehicles/${vehicle.vin}/pick-list`,
    });
  }

  // Customer: look up by matching customer_name in the synced customers table.
  // Email now (SMS lands when T1.5 provider goes live).
  if (!vehicle.customer_name) return;
  const { data: customer } = await serviceSupabase
    .from('customers')
    .select('id, email, phone')
    .ilike('company_name', vehicle.customer_name)
    .maybeSingle();

  if (!customer) return;

  // Open or reuse a thread tied to this vehicle so the customer's reply (or
  // future shop outreach) lands with the right entity context. Requires a
  // primary external_contact; auto-create one if the customer row has
  // email/phone but no contact yet.
  let contactId: string | null = null;
  const { data: existingContact } = await serviceSupabase
    .from('external_contacts')
    .select('id')
    .eq('customer_id', customer.id)
    .eq('is_primary', true)
    .maybeSingle();
  if (existingContact) {
    contactId = existingContact.id;
  } else if (customer.email || customer.phone) {
    const { data: created } = await serviceSupabase
      .from('external_contacts')
      .insert({
        customer_id: customer.id,
        name: vehicle.customer_name,
        email: customer.email || null,
        phone: customer.phone || null,
        is_primary: true,
      })
      .select('id')
      .single();
    contactId = created?.id || null;
  }

  let threadId: string | null = null;
  if (contactId) {
    const { data: openThread } = await serviceSupabase
      .from('customer_threads')
      .select('id')
      .eq('external_contact_id', contactId)
      .eq('context_entity_type', 'fleet_checkin')
      .eq('context_entity_id', vehicle.id)
      .eq('status', 'open')
      .maybeSingle();
    if (openThread) {
      threadId = openThread.id;
    } else {
      const { data: createdThread } = await serviceSupabase
        .from('customer_threads')
        .insert({
          external_contact_id: contactId,
          customer_id: customer.id,
          context_entity_type: 'fleet_checkin',
          context_entity_id: vehicle.id,
          subject: `${vehicleLabel} ready for pickup`,
        })
        .select('id')
        .single();
      threadId = createdThread?.id || null;
    }
  }

  // Email path — always attempted when customer has email
  if (customer.email) {
    try {
      const { sendEmail, buildNotificationEmail } = await import('@/lib/resend');
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
      const emailBody = `The install for your ${vehicleLabel} (VIN ending ${vehicle.vin?.slice(-8)}) is complete. Please contact us to arrange pickup.`;
      const html = buildNotificationEmail(
        `Your vehicle is ready — ${vehicleLabel}`,
        emailBody,
        appUrl,
        'Reply to this email'
      );
      const sent = await sendEmail(customer.email, `[BMG Fleet] Your vehicle is ready — ${vehicleLabel}`, html);
      if (threadId) {
        await serviceSupabase.from('customer_messages').insert({
          thread_id: threadId,
          direction: 'outbound',
          channel: 'email',
          body: emailBody,
          provider_name: 'resend',
          delivery_status: sent ? 'sent' : 'failed',
        });
      }
    } catch (err) {
      console.error('customer completion email failed:', err);
    }
  }

  // SMS path — provider-agnostic, feature-flagged via SMS_PROVIDER_ENABLED
  if (customer.phone) {
    try {
      const { sendSMS } = await import('@/lib/sms-provider');
      const smsBody = `[BMG Fleet] Your ${vehicleLabel} is ready for pickup. VIN ending ${vehicle.vin?.slice(-8)}.`;
      const result = await sendSMS(customer.phone, smsBody);
      if (threadId) {
        await serviceSupabase.from('customer_messages').insert({
          thread_id: threadId,
          direction: 'outbound',
          channel: 'sms',
          body: smsBody,
          provider_name: result.providerName,
          external_provider_sid: result.sid || null,
          delivery_status: result.ok ? 'sent' : (result.skipped ? 'pending' : 'failed'),
        });
      }
    } catch (err) {
      console.error('customer completion SMS failed:', err);
    }
  }
}
