import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { getBillingUserIds } from '@/lib/graphics-invoice-notify';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({ jobId: z.string().uuid() });

/**
 * POST /api/graphics/notify-shipped-invoice
 *
 * Fires when a graphics_job transitions to 'shipped'. Pings the
 * billing-trusted admins with a notification that links to the
 * Invoicing hub with ?invoiceJob=<id>, which loads the job by id and
 * opens the invoice review modal directly. Skips if the job is
 * already invoiced.
 *
 * Body: { jobId: string }
 */


export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId } = parsed.data;

  const { data: job } = await supabase
    .from('graphics_jobs')
    .select('id, title, job_number, customer, netsuite_invoice_id, tracking_number, carrier')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const jobLabel = job.title || `Job #${job.job_number}` || `Job ${job.id.slice(0, 8)}`;

  // Customer shipped email (with tracking when we have it) fires whether or
  // not the job is invoiced — the customer cares about the package, not our
  // billing state. Best-effort; never blocks the billing prompt.
  try {
    const { notifyCustomerByName } = await import('@/lib/customer-notify');
    const { buildNotificationEmail } = await import('@/lib/resend');
    const trackingLine = job.tracking_number
      ? ` Tracking${job.carrier ? ` (${job.carrier})` : ''}: ${job.tracking_number}.`
      : '';
    const emailBody = `Your graphics order — ${jobLabel} — has shipped.${trackingLine} Reply to this email with any questions.`;
    await notifyCustomerByName(supabase, job.customer, {
      contextEntityType: 'graphics_job',
      contextEntityId: job.id,
      threadSubject: `${jobLabel} shipped`,
      emailSubject: `[BMG Fleet] Your graphics have shipped — ${jobLabel}`,
      emailHtml: buildNotificationEmail(`On the way — ${jobLabel}`, emailBody),
      messageBody: emailBody,
    });
  } catch (err) {
    console.error('customer graphics-shipped email failed:', err);
  }

  if (job.netsuite_invoice_id) {
    return NextResponse.json({ skipped: 'already_invoiced' });
  }

  const billingUserIds = await getBillingUserIds(supabase);
  await notifyMany(billingUserIds, {
    type: 'graphics_invoice_prompt',
    title: 'Graphics shipped — create invoice?',
    body: `${jobLabel}${job.customer ? ` for ${job.customer}` : ''} has shipped. Create invoice in FleetSuite?`,
    url: `/invoices?invoiceJob=${job.id}`,
  });

  return NextResponse.json({ notified: billingUserIds.length });
}
