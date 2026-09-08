import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Load ZIP centroids (R6-5). The invite ranker refuses to invent mileage,
 * so this is how real coordinates get in — one import from any public ZIP
 * centroid dataset, in chunks so a 40k-row file doesn't need one giant
 * request.
 *
 * GET reports how many are loaded, which is what the invite picker uses to
 * explain why it is ranking on area instead of miles.
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { count } = await service.from('zip_centroids').select('zip', { count: 'exact', head: true });
  return NextResponse.json({ loaded: count || 0 });
}

const ImportSchema = z.object({
  rows: z.array(z.object({
    zip: z.string().min(3).max(10),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    city: z.string().max(120).optional(),
    state: z.string().max(2).optional(),
  })).min(1).max(5000),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ImportSchema);
  if (parsed.error) return parsed.error;

  const rows = parsed.data.rows
    .map(r => ({
      zip: r.zip.replace(/\D+/g, '').slice(0, 5),
      latitude: r.latitude,
      longitude: r.longitude,
      city: r.city || null,
      state: r.state ? r.state.toUpperCase() : null,
      updated_at: new Date().toISOString(),
    }))
    .filter(r => r.zip.length === 5);
  if (rows.length === 0) return NextResponse.json({ error: 'No row carried a usable 5-digit ZIP.' }, { status: 400 });

  const { error } = await service.from('zip_centroids').upsert(rows, { onConflict: 'zip' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { count } = await service.from('zip_centroids').select('zip', { count: 'exact', head: true });
  return NextResponse.json({ ok: true, upserted: rows.length, loaded: count || 0 });
}
