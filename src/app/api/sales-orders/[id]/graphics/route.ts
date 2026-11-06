import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getSalesOrderRecord } from '@/lib/netsuite';
import { parseSalesOrderRecord } from '@/lib/sales-order-edit';
import { looseOrFilter } from '@/lib/loose-search';
import { buildSoJobPrefill } from '@/lib/so-graphics';
import { loadSoGraphicsCatalog } from '@/lib/so-graphics-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Graphics jobs from a sales order (Craig 2026-11-06, thread "Create graphics
 * jobs from sales orders", picked 1C 2A 3A). Staff, like the New Job form.
 *
 *   GET  ?prefill=1  New Job form values from the order's own lines, for an
 *                    order typed straight into NetSuite (no estimate). An
 *                    order from an estimate uses /api/graphics/from-estimate.
 *   GET  ?q=         graphics jobs to link (job #, title, customer).
 *   POST { jobId }   link an existing job to the order (netsuite_so_id, and
 *                    the order's estimate when the job has none).
 */

const isNsId = (s: string) => /^\d{1,15}$/.test(s);

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!isNsId(params.id)) return NextResponse.json({ error: 'Not a NetSuite sales order id' }, { status: 400 });
  const supabase = createServiceClient();
  const url = new URL(req.url);

  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  if (q) {
    const filter = looseOrFilter(['job_number', 'title', 'customer'], q);
    if (q.length < 2 || !filter) return NextResponse.json({ success: true, jobs: [] });
    const { data, error } = await supabase.from('graphics_jobs')
      .select('id, job_number, title, customer, status, netsuite_so_id, estimate_id')
      .or(filter)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(15);
    if (error) return NextResponse.json({ error: `Couldn't search graphics jobs: ${error.message}` }, { status: 500 });
    return NextResponse.json({
      success: true,
      jobs: (data || []).map((j: any) => ({
        id: j.id, jobNumber: j.job_number, title: j.title, customer: j.customer, status: j.status,
        otherOrder: !!j.netsuite_so_id && j.netsuite_so_id !== params.id,
      })),
    });
  }

  const rec = await getSalesOrderRecord(params.id);
  if (!rec.success) {
    return NextResponse.json({ error: `Couldn't read the sales order from NetSuite: ${rec.error}` }, { status: 502 });
  }
  const so = parseSalesOrderRecord(rec.record);
  const catalog = await loadSoGraphicsCatalog(supabase, so.lines.map(l => l.itemNumber)).catch(() => undefined);
  const prefill = buildSoJobPrefill({ header: so.header, lines: so.lines, catalog });

  // Same default assignee as a job from an estimate: the first approved
  // graphics production user, or nobody so the team picks it up.
  const { data: assignee } = await supabase.from('profiles').select('id')
    .eq('role', 'graphics_production').eq('status', 'approved')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();

  return NextResponse.json({
    success: true,
    prefill: {
      ...prefill,
      customerNetsuiteId: so.header.customerId,
      defaultAssigneeId: assignee?.id || null,
    },
  });
}

const LinkSchema = z.object({ jobId: z.string().uuid() });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!isNsId(params.id)) return NextResponse.json({ error: 'Not a NetSuite sales order id' }, { status: 400 });
  const parsed = await validateBody(req, LinkSchema);
  if (parsed.error) return parsed.error;
  const supabase = createServiceClient();

  const [{ data: job }, { data: est }, { data: mirror }] = await Promise.all([
    supabase.from('graphics_jobs').select('id, job_number, status, netsuite_so_id, estimate_id').eq('id', parsed.data.jobId).maybeSingle(),
    supabase.from('estimates').select('id, estimate_number').eq('netsuite_so_id', params.id).limit(1).maybeSingle(),
    supabase.from('netsuite_sales_orders').select('tranid').eq('netsuite_id', params.id).maybeSingle(),
  ]);
  if (!job) return NextResponse.json({ error: 'That graphics job was not found.' }, { status: 404 });
  if (job.netsuite_so_id && job.netsuite_so_id !== params.id) {
    return NextResponse.json({ error: `${job.job_number || 'That job'} is already linked to another sales order.` }, { status: 409 });
  }
  const soLabel = mirror?.tranid ? `SO #${mirror.tranid}` : 'this sales order';

  const { error } = await supabase.from('graphics_jobs').update({
    netsuite_so_id: params.id,
    ...(est && !job.estimate_id ? { estimate_id: est.id } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', job.id);
  if (error) return NextResponse.json({ error: `Couldn't link the job: ${error.message}` }, { status: 500 });

  await supabase.from('graphics_status_history').insert({
    job_id: job.id, from_status: job.status, to_status: job.status, changed_by: auth.user.id,
    note: `Linked to ${soLabel}`,
  });
  return NextResponse.json({ success: true, jobNumber: job.job_number });
}
