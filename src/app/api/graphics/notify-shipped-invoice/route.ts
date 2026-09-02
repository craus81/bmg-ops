import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { getBillingUserIds } from '@/lib/graphics-invoice-notify';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { deepLinks, carrierTrackingUrl } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  jobId: z.string().uuid(),
  // preview: resolve and return the customer contact without sending —
  // powers the staff confirm dialog's prefilled email.
  preview: z.boolean().optional(),
  // Send the customer shipped email? Only when staff confirmed the dialog.
  notifyCustomer: z.boolean().optional(),
  // Staff-edited recipient for this one send.
  customerEmail: z.string().email().optional().nullable(),
  // Which terminal transition fired this (copy only). The audit's Stage 9
  // finding: the billing ask fired only on 'shipped', so picked-up and
  // direct-installed jobs never prompted anyone to bill them.
  trigger: z.enum(['shipped', 'picked_up', 'installed']).optional(),
});

/**
 * POST /api/graphics/notify-shipped-invoice
 *
 * Fires when a graphics_job transitions to 'shipped'. Always pings the
 * billing-trusted admins with a notification that links to the Invoicing
 * hub with ?invoiceJob=<id> (skipped if already invoiced). The customer
 * shipped email is on-demand only: it goes out when the staffer confirms
 * the dialog (notifyCustomer: true), to the (editable) address they
 * approved.
 *
 * Body: { jobId: string, preview?: boolean, notifyCustomer?: boolean, customerEmail?: string }
 */


export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, preview, notifyCustomer, customerEmail, trigger } = parsed.data;

  const { data: job } = await supabase
    .from('graphics_jobs')
    .select('id, title, job_number, customer, netsuite_invoice_id, tracking_number, carrier')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const jobLabel = job.title || `Job #${job.job_number}` || `Job ${job.id.slice(0, 8)}`;

  if (preview) {
    const { resolveCustomerContact } = await import('@/lib/customer-notify');
    const resolved = job.customer
      ? await resolveCustomerContact(supabase, job.customer)
      : { email: null, phone: null };
    return NextResponse.json({
      preview: true,
      customer: job.customer || null,
      email: resolved.email,
      phone: resolved.phone,
    });
  }

  // Customer shipped email (with tracking when we have it) — on-demand
  // only, to the address the staffer confirmed. Best-effort; never blocks
  // the billing prompt.
  if (notifyCustomer) {
    try {
      const { notifyCustomerByName } = await import('@/lib/customer-notify');
      const { buildNotificationEmail } = await import('@/lib/resend');
      const trackingLine = job.tracking_number
        ? ` Tracking${job.carrier ? ` (${job.carrier})` : ''}: ${job.tracking_number}.`
        : '';
      const emailBody = `Your graphics order — ${jobLabel} — has shipped.${trackingLine} Reply to this email with any questions.`;
      // CTA goes to the public carrier tracking page — customers can't open
      // internal app pages, so with no tracking number there's no button.
      const trackingUrl = carrierTrackingUrl(job.carrier, job.tracking_number);
      await notifyCustomerByName(supabase, job.customer, {
        contextEntityType: 'graphics_job',
        contextEntityId: job.id,
        threadSubject: `${jobLabel} shipped`,
        emailSubject: `[BMG Fleet] Your graphics have shipped — ${jobLabel}`,
        emailHtml: trackingUrl
          ? buildNotificationEmail(`On the way — ${jobLabel}`, emailBody, trackingUrl, 'Track shipment')
          : buildNotificationEmail(`On the way — ${jobLabel}`, emailBody),
        messageBody: emailBody,
        respectOptOut: false,
        overrideEmail: customerEmail || null,
        replyTo: auth.user?.email || null,
      });
    } catch (err) {
      console.error('customer graphics-shipped email failed:', err);
    }
  }

  if (job.netsuite_invoice_id) {
    return NextResponse.json({ skipped: 'already_invoiced' });
  }

  const verb = trigger === 'picked_up' ? 'was picked up'
    : trigger === 'installed' ? 'was installed'
    : 'has shipped';
  const titleVerb = trigger === 'picked_up' ? 'picked up'
    : trigger === 'installed' ? 'installed'
    : 'shipped';
  const billingUserIds = await getBillingUserIds(supabase);
  await notifyMany(billingUserIds, {
    type: 'graphics_invoice_prompt',
    title: `Graphics ${titleVerb} — create invoice?`,
    body: `${jobLabel}${job.customer ? ` for ${job.customer}` : ''} ${verb}. Create invoice in FleetSuite?`,
    url: deepLinks.createInvoiceForJob(job.id),
  });

  return NextResponse.json({ notified: billingUserIds.length });
}
