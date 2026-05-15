import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { requireAuth } from '@/lib/api-auth';
import { sendEmail, buildNotificationEmail } from '@/lib/resend';
import { sendSMS } from '@/lib/sms-provider';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({ jobId: z.string().uuid() });

/**
 * POST /api/graphics/notify-pickup
 *
 * Fires when a graphics_job transitions to 'ready_to_pickup'. Tells the
 * customer their graphics are ready to collect (email + SMS when the
 * provider flag is on) and pings the internal graphics/admin team so they
 * know the customer was contacted. Also threads the outbound messages
 * into customer_threads so the inbox carries the full conversation.
 *
 * Body: { jobId: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId } = parsed.data;

  try {

    const { data: job } = await supabase
      .from('graphics_jobs')
      .select('id, title, job_number, part_number, customer, quantity, notes, created_by, assigned_to, ship_to')
      .eq('id', jobId)
      .single();
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const jobLabel = job.title || job.part_number || `Job #${job.job_number}` || `Job ${job.id.slice(0, 8)}`;

    // ── Internal awareness: admins + graphics team + creator + assignee ──
    const internalTargets = new Set<string>();
    if (job.created_by) internalTargets.add(job.created_by);
    if (job.assigned_to) internalTargets.add(job.assigned_to);
    const { data: internalStaff } = await supabase
      .from('profiles')
      .select('id, role, roles')
      .or('role.in.(admin,graphics_production,production,sales),roles.cs.{admin},roles.cs.{graphics_production},roles.cs.{sales}');
    for (const p of internalStaff || []) internalTargets.add(p.id);

    if (internalTargets.size > 0) {
      await notifyMany(Array.from(internalTargets), {
        type: 'graphics_ready_for_pickup',
        title: `Ready for pickup: ${jobLabel}`,
        body: `${job.customer || 'Customer'} has been notified that ${jobLabel} is ready for pickup.`,
        url: '/graphics',
      });
    }

    // ── Customer-facing: email (+ flag-gated SMS) ──
    const dispatch: Record<string, any> = { email: null, sms: null, threadId: null };
    if (!job.customer) {
      return NextResponse.json({
        internalNotified: internalTargets.size,
        dispatch,
        warning: 'No customer on graphics_job — skipping customer notification.',
      });
    }

    const { data: customerRow } = await supabase
      .from('customers')
      .select('id, email, phone, company_name')
      .ilike('company_name', job.customer)
      .maybeSingle();

    // Resolve the primary external contact (falls back to the synced
    // customers row when no external_contacts exist).
    let contactId: string | null = null;
    let contactEmail: string | null = null;
    let contactPhone: string | null = null;
    let customerId: string | null = customerRow?.id || null;

    if (customerId) {
      const { data: primary } = await supabase
        .from('external_contacts')
        .select('id, email, phone')
        .eq('customer_id', customerId)
        .eq('is_primary', true)
        .maybeSingle();
      if (primary) {
        contactId = primary.id;
        contactEmail = primary.email || null;
        contactPhone = primary.phone || null;
      } else if (customerRow?.email || customerRow?.phone) {
        const { data: created } = await supabase
          .from('external_contacts')
          .insert({
            customer_id: customerId,
            name: customerRow.company_name || job.customer,
            email: customerRow.email || null,
            phone: customerRow.phone || null,
            is_primary: true,
            created_by: auth.user.id,
          })
          .select('id')
          .single();
        contactId = created?.id || null;
        contactEmail = customerRow.email || null;
        contactPhone = customerRow.phone || null;
      }
    }

    if (!contactEmail && !contactPhone) {
      return NextResponse.json({
        internalNotified: internalTargets.size,
        dispatch,
        warning: 'No customer email/phone on file — skipping customer notification.',
      });
    }

    // Open or reuse a thread scoped to this graphics_job
    let threadId: string | null = null;
    if (contactId) {
      const { data: existing } = await supabase
        .from('customer_threads')
        .select('id')
        .eq('external_contact_id', contactId)
        .eq('context_entity_type', 'graphics_job')
        .eq('context_entity_id', job.id)
        .eq('status', 'open')
        .maybeSingle();
      if (existing) {
        threadId = existing.id;
      } else {
        const { data: created } = await supabase
          .from('customer_threads')
          .insert({
            external_contact_id: contactId,
            customer_id: customerId,
            context_entity_type: 'graphics_job',
            context_entity_id: job.id,
            subject: `${jobLabel} ready for pickup`,
            created_by: auth.user.id,
          })
          .select('id')
          .single();
        threadId = created?.id || null;
      }
    }
    dispatch.threadId = threadId;

    const pickupAddress = job.ship_to
      ? `Pickup from: ${typeof job.ship_to === 'string' ? job.ship_to : JSON.stringify(job.ship_to)}`
      : 'Please contact us to arrange pickup.';

    if (contactEmail) {
      try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
        const jobCardUrl = `${appUrl}/graphics?id=${job.id}`;
        const emailBody = `Your graphics for ${jobLabel}${job.quantity ? ` (qty ${job.quantity})` : ''} are ready for pickup. ${pickupAddress}`;
        const html = buildNotificationEmail(
          `Your graphics are ready for pickup — ${jobLabel}`,
          emailBody,
          jobCardUrl,
          'Open job card',
        );
        const ok = await sendEmail(
          contactEmail,
          `[BMG Fleet] Your graphics are ready for pickup — ${jobLabel}`,
          html,
        );
        dispatch.email = { target: contactEmail, ok };
        if (threadId) {
          await supabase.from('customer_messages').insert({
            thread_id: threadId,
            direction: 'outbound',
            channel: 'email',
            body: emailBody,
            provider_name: 'resend',
            sent_by: auth.user.id,
            delivery_status: ok ? 'sent' : 'failed',
          });
        }
      } catch (err: any) {
        dispatch.email = { target: contactEmail, ok: false, error: err?.message };
      }
    }

    if (contactPhone) {
      try {
        const smsBody = `[BMG Fleet] Your graphics for ${jobLabel} are ready for pickup.`;
        const result = await sendSMS(contactPhone, smsBody);
        dispatch.sms = {
          target: contactPhone,
          ok: result.ok,
          skipped: result.skipped || false,
          providerName: result.providerName,
          error: result.error || null,
        };
        if (threadId) {
          await supabase.from('customer_messages').insert({
            thread_id: threadId,
            direction: 'outbound',
            channel: 'sms',
            body: smsBody,
            provider_name: result.providerName,
            external_provider_sid: result.sid || null,
            sent_by: auth.user.id,
            delivery_status: result.ok ? 'sent' : (result.skipped ? 'pending' : 'failed'),
          });
        }
      } catch (err: any) {
        dispatch.sms = { target: contactPhone, ok: false, error: err?.message };
      }
    }

    console.log('[notify-pickup] dispatch', {
      jobId,
      internalNotified: internalTargets.size,
      threadId,
      email: dispatch.email?.ok,
      sms: dispatch.sms?.ok,
      smsSkipped: dispatch.sms?.skipped,
    });

    return NextResponse.json({
      internalNotified: internalTargets.size,
      dispatch,
    });
  } catch (err: any) {
    console.error('notify-pickup error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
