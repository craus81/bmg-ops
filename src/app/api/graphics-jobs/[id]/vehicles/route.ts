import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/graphics-jobs/[id]/vehicles
 *
 * The vehicles linked to a graphics job (fleet_checkins.matched_graphics_job_id)
 * with the proof pulled at check-in, so the job page can show the vehicle's
 * proof and check-in photos without copying them. Photos themselves come
 * from /api/vehicles/[vin]/photos?visit=<id>, pinned to each visit.
 *
 * Archived visits stay listed: the files belong to the job's history.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const jobId = (params.id || '').trim();
  if (!jobId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { data, error } = await supabase
    .from('fleet_checkins')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model, sales_order_number, created_at, proof_url, proof_filename, proof_dropbox_path, proof_file_path, proof_file_name')
    .eq('matched_graphics_job_id', jobId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const vehicles = (data || []).map(c => ({
    id: c.id,
    vin: c.vin,
    year: c.vehicle_year,
    make: c.vehicle_make,
    model: c.vehicle_model,
    salesOrderNumber: c.sales_order_number,
    checkedInAt: c.created_at,
    // Same precedence the tracking page uses: proof_url (a direct upload or
    // the R2 copy of a Dropbox pick), then a Dropbox pick still copying,
    // then an app proof chosen from graphics_proofs.
    proof: c.proof_url || c.proof_dropbox_path || c.proof_file_path
      ? {
          url: c.proof_url || null,
          dropboxPath: c.proof_dropbox_path || null,
          filePath: c.proof_url ? null : (c.proof_file_path || null),
          fileName: c.proof_filename || c.proof_file_name || null,
        }
      : null,
  }));

  return NextResponse.json({ vehicles });
}
