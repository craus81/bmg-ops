import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/graphics/notify-shipped-invoice
 *
 * Fires when a graphics_job transitions to 'shipped'. Pings the
 * billing-trusted admins (Craig George + Jessie Whittington) with a
 * notification that links back to /graphics with ?invoiceJob=<id>, where
 * the page surfaces a confirm prompt and (on yes) opens the invoice
 * modal. Skips if the job is already invoiced.
 *
 * Body: { jobId: string }
 */

const INVOICE_PROMPT_RECIPIENTS = ['Craig George', 'Jessie Whittington'];

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const { jobId } = await req.json().catch(() => ({}));
  if (!jobId) return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });

  const { data: job } = await supabase
    .from('graphics_jobs')
    .select('id, title, job_number, customer, netsuite_invoice_id')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  if (job.netsuite_invoice_id) {
    return NextResponse.json({ skipped: 'already_invoiced' });
  }

  const { data: targetProfiles } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('full_name', INVOICE_PROMPT_RECIPIENTS);

  const userIds = (targetProfiles || []).map((p) => p.id);
  if (userIds.length === 0) {
    return NextResponse.json({ warning: 'No matching recipients found', recipients: INVOICE_PROMPT_RECIPIENTS });
  }

  const jobLabel = job.title || `Job #${job.job_number}` || `Job ${job.id.slice(0, 8)}`;

  await notifyMany(userIds, {
    type: 'graphics_invoice_prompt',
    title: 'Graphics shipped — create invoice?',
    body: `${jobLabel}${job.customer ? ` for ${job.customer}` : ''} has shipped. Create invoice in FleetSuite?`,
    url: `/graphics?invoiceJob=${job.id}`,
  });

  return NextResponse.json({ notified: userIds.length });
}
