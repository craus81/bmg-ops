import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';
import { safeStringLiteral, SqlSafeError } from '@/lib/sql-safe';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  jobId: z.string().uuid(),
  invoiceNumber: z.string().trim().max(60).optional().nullable(),
});

/**
 * POST /api/graphics/mark-invoiced
 * Body: { jobId, invoiceNumber? }
 *
 * Marks a graphics job as invoiced OUTSIDE FleetSuite so it stops showing up
 * in the ready-to-invoice queues. If an invoice number is given, it's looked
 * up in NetSuite and the job links to the real invoice (PDF/email work as
 * normal). If it's blank or not found, the job is stamped with the sentinel
 * id 'external' — cleared out, but with no NetSuite record behind it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId } = parsed.data;
  const invoiceNumber = (parsed.data.invoiceNumber || '').trim();

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: job } = await supabase
      .from('graphics_jobs')
      .select('id, status, netsuite_invoice_id, netsuite_invoice_number')
      .eq('id', jobId)
      .maybeSingle();
    if (!job) return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    if (job.netsuite_invoice_id) {
      return NextResponse.json({
        error: `Already invoiced as ${job.netsuite_invoice_number || job.netsuite_invoice_id}`,
      }, { status: 400 });
    }

    // Try to link the real NetSuite invoice when a number was provided.
    let invoiceId = 'external';
    let storedNumber = invoiceNumber || 'External';
    let linked = false;
    if (invoiceNumber) {
      try {
        const lookup = await suiteqlQuery(
          `SELECT id, tranid FROM transaction WHERE type = 'CustInvc' AND UPPER(tranid) = UPPER('${safeStringLiteral(invoiceNumber, 60)}')`
        );
        const row = lookup?.items?.[0];
        if (row?.id) {
          invoiceId = String(row.id);
          storedNumber = String(row.tranid || invoiceNumber);
          linked = true;
        }
      } catch (err: any) {
        if (err instanceof SqlSafeError) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        // NetSuite lookup failing shouldn't block clearing the job out —
        // fall through to the external sentinel.
        console.warn('mark-invoiced NetSuite lookup failed:', err?.message);
      }
    }

    await supabase
      .from('graphics_jobs')
      .update({
        netsuite_invoice_id: invoiceId,
        netsuite_invoice_number: storedNumber,
        invoiced_at: new Date().toISOString(),
        invoiced_by: auth.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    await supabase.from('graphics_status_history').insert({
      job_id: jobId,
      from_status: job.status,
      to_status: job.status,
      changed_by: auth.user.id,
      note: linked
        ? `Marked as invoiced — linked to NetSuite invoice #${storedNumber}`
        : `Marked as invoiced outside FleetSuite${invoiceNumber ? ` (invoice "${invoiceNumber}" not found in NetSuite)` : ''}`,
    });

    return NextResponse.json({ success: true, invoiceId, invoiceNumber: storedNumber, linked });
  } catch (err: any) {
    console.error('mark-invoiced error:', err);
    return NextResponse.json({ error: err.message || 'Failed to mark job invoiced' }, { status: 500 });
  }
}
