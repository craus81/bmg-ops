import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { r2Get } from '@/lib/r2';
import { validateBody, z } from '@/lib/validate';
import { computeCalibration, parseScaleFactor } from '@/lib/template-calibration';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CalibrateSchema = z.object({
  // Cursor pagination so a failed row is never retried in a loop: the client
  // keeps calling with the returned nextCursor until it comes back null.
  cursor: z.string().uuid().optional().nullable(),
  batchSize: z.number().int().positive().max(50).optional(),
});

async function fetchBytes(path: string): Promise<Uint8Array | null> {
  try {
    if (path.startsWith('http')) {
      const res = await fetch(path);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    }
    const r = await r2Get('vehicle-templates', path);
    if (!r.success || !r.body) return null;
    return new Uint8Array(await new Response(r.body).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * POST /api/admin/calibrate-templates
 *
 * Backfills wrap-estimator scale calibration (px_per_in) for existing
 * vehicle templates by reading each template's vector artboard size (EPS
 * BoundingBox / AI MediaBox) and preview pixel dimensions. Processes one
 * batch per call; loop with the returned nextCursor until it is null.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, CalibrateSchema);
  if (parsed.error) return parsed.error;
  const batchSize = parsed.data.batchSize ?? 20;

  let query = supabase
    .from('vehicle_templates')
    .select('id, name, scale, original_file_path, template_image_path')
    .is('px_per_in', null)
    .not('original_file_path', 'is', null)
    .not('template_image_path', 'is', null)
    .order('id', { ascending: true })
    .limit(batchSize);
  if (parsed.data.cursor) query = query.gt('id', parsed.data.cursor);

  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: { id: string; name: string; status: 'calibrated' | 'skipped'; reason?: string; pxPerIn?: number }[] = [];

  for (const row of rows || []) {
    const [vec, img] = await Promise.all([
      fetchBytes(row.original_file_path),
      fetchBytes(row.template_image_path),
    ]);
    if (!vec || !img) {
      results.push({ id: row.id, name: row.name, status: 'skipped', reason: 'file-unavailable' });
      continue;
    }
    const cal = computeCalibration(vec, img, parseScaleFactor(row.scale));
    if (cal.pxPerIn) {
      const { error: upErr } = await supabase
        .from('vehicle_templates')
        .update({ px_per_in: cal.pxPerIn })
        .eq('id', row.id);
      if (upErr) {
        results.push({ id: row.id, name: row.name, status: 'skipped', reason: upErr.message });
      } else {
        results.push({ id: row.id, name: row.name, status: 'calibrated', pxPerIn: cal.pxPerIn });
      }
    } else {
      results.push({ id: row.id, name: row.name, status: 'skipped', reason: cal.reason });
    }
  }

  const nextCursor = (rows || []).length === batchSize ? rows![rows!.length - 1].id : null;

  return NextResponse.json({
    success: true,
    results,
    calibrated: results.filter(r => r.status === 'calibrated').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    nextCursor,
  });
}
