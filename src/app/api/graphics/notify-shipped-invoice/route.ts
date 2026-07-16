import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { INVOICE_PROMPT_USER_IDS } from '@/lib/graphics-invoice-notify';
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
    .select('id, title, job_number, customer, netsuite_invoice_id')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  if (job.netsuite_invoice_id) {
    return NextResponse.json({ skipped: 'already_invoiced' });
  }

  const jobLabel = job.title || `Job #${job.job_number}` || `Job ${job.id.slice(0, 8)}`;

  await notifyMany(INVOICE_PROMPT_USER_IDS, {
    type: 'graphics_invoice_prompt',
    title: 'Graphics shipped — create invoice?',
    body: `${jobLabel}${job.customer ? ` for ${job.customer}` : ''} has shipped. Create invoice in FleetSuite?`,
    url: `/invoices?invoiceJob=${job.id}`,
  });

  return NextResponse.json({ notified: INVOICE_PROMPT_USER_IDS.length });
}
