import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { detectFitment } from '@/lib/vehicle-fitment';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST { mode: 'auto-tag' } — N4-B2 phase 1: sweep every active part's
 * text (number, names, descriptions, legacy vehicle_type) with
 * detectFitment() and upsert advisory part_fitment rows
 * (source='description'). Idempotent: the unique index absorbs re-runs,
 * and human/manual rows are never touched.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, z.object({ mode: z.literal('auto-tag') }));
  if (parsed.error) return parsed.error;

  try {
    const { data: platforms } = await supabase.from('vehicle_platforms').select('id, key').eq('active', true);
    const idByKey = new Map((platforms || []).map((p: { id: string; key: string }) => [p.key, p.id]));

    const { data: parts, error } = await fetchAllRows<any>((from, to) => supabase
      .from('netsuite_parts')
      .select('id, item_number, display_name, description, marketing_description, vehicle_type')
      .eq('is_active', true)
      .order('id')
      .range(from, to));
    if (error) throw new Error('Parts read failed: ' + error.message);

    const rows: { part_id: string; platform_id: string; wheelbase_label: string | null; roof_label: string | null; source: string }[] = [];
    const perPlatform: Record<string, number> = {};
    let taggedParts = 0;
    for (const p of parts || []) {
      const text = [p.item_number, p.display_name, p.description, p.marketing_description, p.vehicle_type]
        .filter(Boolean).join(' \n ');
      const hits = detectFitment(text);
      if (hits.length === 0) continue;
      taggedParts++;
      for (const h of hits) {
        const platformId = idByKey.get(h.platformKey);
        if (!platformId) continue;
        rows.push({ part_id: p.id, platform_id: platformId, wheelbase_label: h.wheelbase, roof_label: h.roof, source: 'description' });
        perPlatform[h.platformKey] = (perPlatform[h.platformKey] || 0) + 1;
      }
    }

    // Upsert in chunks; the COALESCE unique index makes re-runs no-ops.
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error: insErr, count } = await supabase
        .from('part_fitment')
        .upsert(chunk, { onConflict: 'part_id,platform_id,wheelbase_label,roof_label', ignoreDuplicates: true, count: 'exact' });
      // COALESCE-index conflicts aren't addressable via onConflict columns —
      // fall back to insert-ignore semantics on error 42P10 by inserting rows
      // one at a time only for the failed chunk.
      if (insErr) {
        for (const r of chunk) {
          const { error: oneErr } = await supabase.from('part_fitment').insert(r);
          if (!oneErr) inserted++;
        }
      } else {
        inserted += count ?? chunk.length;
      }
    }

    return NextResponse.json({ scanned: (parts || []).length, taggedParts, tagRows: rows.length, inserted, perPlatform });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Auto-tag failed' }, { status: 500 });
  }
}
