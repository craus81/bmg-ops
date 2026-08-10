import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const AssignSchema = z.object({
  jobId: z.string().uuid(),
  poId: z.string().uuid(),
  partNumber: z.string().trim().max(120).optional().nullable(),
});

// GET: search POs for the "Link PO" picker on an already-created graphics job
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const q = req.nextUrl.searchParams.get('q')?.trim() || '';

  let query = supabase
    .from('purchase_orders')
    .select('id, po_number, customer, customer_netsuite_id, status, ordered_date, po_line_items(id, part_number, description, quantity, installed, unit_price)')
    .in('status', ['open', 'complete'])
    .order('created_at', { ascending: false })
    .limit(20);

  if (q.length >= 2) {
    query = query.or(`po_number.ilike.%${q}%,customer.ilike.%${q}%`);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ pos: data || [] });
}

// POST: link an existing graphics job to a PO (and, if the part number
// matches one of its line items, to that specific line). Used when a
// customer's PO arrives after the graphics job was already entered —
// common with Bodewell.
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, AssignSchema);
  if (parsed.error) return parsed.error;
  const { jobId, poId, partNumber } = parsed.data;

  try {
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .select('po_number, customer, customer_netsuite_id')
      .eq('id', poId)
      .single();

    if (poErr || !po) {
      return NextResponse.json({ error: 'PO not found' }, { status: 404 });
    }

    const { data: job, error: jobErr } = await supabase
      .from('graphics_jobs')
      .select('status')
      .eq('id', jobId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    }

    const { data: lineItems } = await supabase
      .from('po_line_items')
      .select('id, part_number')
      .eq('po_id', poId);

    // Best-effort match to a specific line by part number — the job links to
    // the PO either way, this just also narrows to one line when possible.
    let matchedLineId: string | null = null;
    if (partNumber && lineItems && lineItems.length > 0) {
      const exact = lineItems.find((l) => l.part_number?.toLowerCase() === partNumber.toLowerCase());
      matchedLineId = exact?.id
        ?? lineItems.find((l) => l.part_number?.toLowerCase().includes(partNumber.toLowerCase()))?.id
        ?? null;
    }

    const { error: updateErr } = await supabase
      .from('graphics_jobs')
      .update({
        po_id: poId,
        po_line_item_id: matchedLineId,
        po_number: po.po_number,
        customer_netsuite_id: po.customer_netsuite_id,
        updated_by: auth.user.id,
      })
      .eq('id', jobId);

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    await supabase.from('graphics_status_history').insert({
      job_id: jobId,
      from_status: job.status,
      to_status: job.status,
      changed_by: auth.user.id,
      note: `Linked to PO #${po.po_number}`,
    });

    return NextResponse.json({
      success: true,
      po_number: po.po_number,
      customer: po.customer,
      matched_line_item_id: matchedLineId,
    });
  } catch (err: any) {
    console.error('Graphics job assign-po error:', err);
    return NextResponse.json({ error: err.message || 'Failed to link PO' }, { status: 500 });
  }
}
