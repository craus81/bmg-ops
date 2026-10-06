import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { coveragePictures } from '@/lib/estimate-graphics';
import { estimateHeadlineNumber } from '@/lib/estimate-number';
import { estimateVehicleLine } from '@/lib/graphics-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/graphics-jobs/[id]/sources
 *
 * The estimate/SO and wrap quote a graphics job came from, read live so the
 * job page shows their current state without copying anything: the sales
 * rep (whoever wrote the estimate, else the quote), the vehicle, the
 * customer's PO, and the wrap quote's coverage proofs and attached files.
 * No prices — every staff role that opens the job sees this.
 *
 * Proof and file entries are storage paths in the vehicle-templates bucket;
 * the page turns them into URLs the same way the wrap quote screen does.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const jobId = (params.id || '').trim();
  if (!jobId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { data: job, error } = await supabase
    .from('graphics_jobs')
    .select('id, estimate_id, wrap_quote_id')
    .eq('id', jobId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!job) return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });

  const [{ data: est }, { data: quote }] = await Promise.all([
    job.estimate_id
      ? supabase
          .from('estimates')
          .select('id, estimate_number, netsuite_estimate_number, netsuite_so_number, po_number, vin, unit_number, vehicle_year, vehicle_other, created_by, vehicle_platforms(label)')
          .eq('id', job.estimate_id)
          .maybeSingle()
      : Promise.resolve({ data: null as any }),
    job.wrap_quote_id
      ? supabase
          .from('wrap_quotes')
          .select('id, quote_number, vehicle_description, diagram_path, photo_path, photo_boxes, photo_proofs, attachments, created_by')
          .eq('id', job.wrap_quote_id)
          .maybeSingle()
      : Promise.resolve({ data: null as any }),
  ]);

  const repId: string | null = (est as any)?.created_by || (quote as any)?.created_by || null;
  let salesRep: { id: string; name: string } | null = null;
  if (repId) {
    const { data: p } = await supabase.from('profiles').select('id, full_name').eq('id', repId).maybeSingle();
    if (p?.full_name) salesRep = { id: p.id, name: p.full_name };
  }

  const files = Array.isArray((quote as any)?.attachments) ? (quote as any).attachments : [];

  return NextResponse.json({
    salesRep,
    estimate: est
      ? {
          id: est.id,
          number: estimateHeadlineNumber(est as any),
          soNumber: (est as any).netsuite_so_number || null,
          poNumber: (est as any).po_number || null,
          vehicle: estimateVehicleLine(est),
        }
      : null,
    wrapQuote: quote
      ? {
          id: quote.id,
          number: (quote as any).quote_number,
          vehicle: (quote as any).vehicle_description || null,
          proofs: coveragePictures(quote),
          files: files
            .filter((f: any) => f && typeof f.path === 'string')
            .map((f: any) => ({ name: f.name || f.path.split('/').pop(), path: f.path, size: Number(f.size) || 0, type: f.type || null })),
        }
      : null,
  });
}
