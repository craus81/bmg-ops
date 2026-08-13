import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Saved vendor-import profiles (Craig 2026-08-11: "we should save imports
 * so we can re run them easily"). A profile is the whole recipe — site,
 * teach-mode listing URLs, vendor filter + tag — plus the cached discovery
 * result, so a re-run is load → Import instead of a fresh multi-minute
 * catalog walk. Admin-only; the table is RLS-locked to service role.
 */

const SaveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().min(1).max(300),
  listingUrls: z.array(z.string().trim().max(1000)).max(20).optional(),
  vendorScope: z.string().trim().max(200).optional(),
  setVendor: z.string().trim().max(200).optional(),
  discoveredUrls: z.array(z.string().trim().max(1000)).max(5000).optional(),
});

const RunStatsSchema = z.object({
  id: z.string().uuid(),
  lastRunStats: z.object({
    pages: z.number().int().min(0),
    matched: z.number().int().min(0),
    imagesSaved: z.number().int().min(0),
    descriptionsSaved: z.number().int().min(0),
    vendorsSet: z.number().int().min(0),
    fitmentTagged: z.number().int().min(0).optional(),
  }),
});

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { data, error } = await supabase
    .from('vendor_import_profiles')
    .select('id, name, base_url, listing_urls, vendor_scope, set_vendor, discovered_urls, discovered_at, last_run_at, last_run_stats')
    .order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ profiles: data || [] });
}

/** Create or update a profile (upsert by id when given, else by name). */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, SaveSchema);
  if (parsed.error) return parsed.error;
  const b = parsed.data;

  const row: Record<string, unknown> = {
    name: b.name,
    base_url: b.baseUrl,
    listing_urls: b.listingUrls || [],
    vendor_scope: b.vendorScope || null,
    set_vendor: b.setVendor || null,
    updated_at: new Date().toISOString(),
  };
  if (b.discoveredUrls) {
    row.discovered_urls = b.discoveredUrls;
    row.discovered_at = new Date().toISOString();
  }

  const query = b.id
    ? supabase.from('vendor_import_profiles').update(row).eq('id', b.id).select('id').single()
    : supabase.from('vendor_import_profiles').upsert({ ...row, name: b.name }, { onConflict: 'name' }).select('id').single();
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === '23505' ? 409 : 500 });
  return NextResponse.json({ id: data.id });
}

/** Record a run's results on a profile. */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, RunStatsSchema);
  if (parsed.error) return parsed.error;

  const { error } = await supabase
    .from('vendor_import_profiles')
    .update({ last_run_at: new Date().toISOString(), last_run_stats: parsed.data.lastRunStats, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, z.object({ id: z.string().uuid() }));
  if (parsed.error) return parsed.error;

  const { error } = await supabase.from('vendor_import_profiles').delete().eq('id', parsed.data.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
