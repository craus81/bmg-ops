import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { r2Delete } from '@/lib/r2';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Small enough that a batch (DB deletes + up to 2 R2 deletes per row)
// comfortably fits a serverless execution window; the client loops until
// remaining hits 0.
const BATCH = 25;

const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/**
 * POST /api/admin/clear-templates
 *
 * Wipes the vehicle template library ahead of a fresh bulk import, one batch
 * per call — loop until `remaining` is 0. Templates referenced by a quote
 * (AI quoting or wrap quotes), and templates the database refuses to delete
 * (unexpected FK references), are retired (is_active = false) instead of
 * deleted so nothing breaks; retired rows are excluded from later batches,
 * which is what makes the loop converge.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { data: rows, error } = await supabase
    .from('vehicle_templates')
    .select('id, template_image_path, original_file_path, is_active');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ success: true, deleted: 0, retired: 0, filesDeleted: 0, remaining: 0 });
  }

  // Templates referenced by any quote must survive as retired rows. A failed
  // lookup (e.g. wrap_quotes not migrated yet) contributes no references.
  const referenced = new Set<string>();
  const [q1, q2] = await Promise.all([
    supabase.from('quotes').select('template_id').not('template_id', 'is', null),
    supabase.from('wrap_quotes').select('template_id').not('template_id', 'is', null),
  ]);
  for (const r of [...(q1.data || []), ...(q2.data || [])]) {
    if (r.template_id) referenced.add(r.template_id);
  }

  let retired = 0;

  // Retire quote-referenced rows that are still active (idempotent — they're
  // skipped on subsequent calls once inactive).
  const refsToRetire = rows.filter(r => referenced.has(r.id) && r.is_active !== false).map(r => r.id);
  for (const ids of chunk(refsToRetire, 200)) {
    const { error: retErr } = await supabase.from('vehicle_templates').update({ is_active: false }).in('id', ids);
    if (retErr) return NextResponse.json({ error: `Retire failed: ${retErr.message}` }, { status: 500 });
  }
  retired += refsToRetire.length;

  // Delete one batch of unreferenced, still-active rows.
  const candidates = rows.filter(r => !referenced.has(r.id) && r.is_active !== false);
  const batch = candidates.slice(0, BATCH);

  let deleted = 0;
  let filesDeleted = 0;
  for (const row of batch) {
    // Best-effort storage cleanup (legacy rows may hold full URLs from the
    // Supabase-storage era — those are left alone; orphans are harmless).
    const paths = [row.template_image_path, row.original_file_path]
      .filter((p): p is string => !!p && !p.startsWith('http'));
    const results = await Promise.allSettled(paths.map(p => r2Delete('vehicle-templates', p)));
    filesDeleted += results.filter(r => r.status === 'fulfilled' && (r.value as any)?.success).length;

    const { error: delErr } = await supabase.from('vehicle_templates').delete().eq('id', row.id);
    if (delErr) {
      // Unexpected FK reference — retire instead so the sweep keeps moving.
      await supabase.from('vehicle_templates').update({ is_active: false }).eq('id', row.id);
      retired++;
    } else {
      deleted++;
    }
  }

  return NextResponse.json({
    success: true,
    deleted,
    retired,
    filesDeleted,
    remaining: candidates.length - batch.length,
  });
}
