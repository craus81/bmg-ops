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
 * billing-trusted admins with a notification that links back to
 * /graphics with ?invoiceJob=<id>, where the page surfaces a confirm
 * prompt and (on yes) opens the invoice modal. Skips if the job is
 * already invoiced.
 *
 * Body: { jobId: string }
 */

// Hardcoded user UUIDs for now. Survives name/email changes. Swap to a
// `notify_invoice_prompts` boolean on profiles once the recipient list
// needs self-serve management.
const INVOICE_PROMPT_USER_IDS = [
  'f9f8a88c-1049-4bd5-95db-888787677ac9', // Craig George
  '13c993b2-bb84-4539-8bbc-6c85395f558c', // Jessie Whittington
];

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

  const jobLabel = job.title || `Job #${job.job_number}` || `Job ${job.id.slice(0, 8)}`;

  await notifyMany(INVOICE_PROMPT_USER_IDS, {
    type: 'graphics_invoice_prompt',
    title: 'Graphics shipped — create invoice?',
    body: `${jobLabel}${job.customer ? ` for ${job.customer}` : ''} has shipped. Create invoice in FleetSuite?`,
    url: `/graphics?invoiceJob=${job.id}`,
  });

  return NextResponse.json({ notified: INVOICE_PROMPT_USER_IDS.length });
}
