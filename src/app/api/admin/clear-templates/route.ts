import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { r2Delete } from '@/lib/r2';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/**
 * POST /api/admin/clear-templates
 *
 * Wipes the vehicle template library ahead of a fresh bulk import. Templates
 * still referenced by a quote (AI quoting or wrap quotes) are retired
 * (is_active = false) instead of deleted so quote history keeps its FK;
 * everything else is deleted along with its stored preview/original files.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { data: rows, error } = await supabase
    .from('vehicle_templates')
    .select('id, template_image_path, original_file_path');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ success: true, deleted: 0, retired: 0, filesDeleted: 0 });
  }

  // Templates referenced by any quote must survive as retired rows.
  const referenced = new Set<string>();
  const [q1, q2] = await Promise.all([
    supabase.from('quotes').select('template_id').not('template_id', 'is', null),
    supabase.from('wrap_quotes').select('template_id').not('template_id', 'is', null),
  ]);
  for (const r of [...(q1.data || []), ...(q2.data || [])]) {
    if (r.template_id) referenced.add(r.template_id);
  }

  const toDelete = rows.filter(r => !referenced.has(r.id));
  const toRetire = rows.filter(r => referenced.has(r.id));

  // Best-effort storage cleanup for deleted rows (legacy rows may store full
  // URLs from the Supabase-storage era — those are left alone).
  let filesDeleted = 0;
  for (const row of toDelete) {
    for (const path of [row.template_image_path, row.original_file_path]) {
      if (!path || path.startsWith('http')) continue;
      try {
        const res = await r2Delete('vehicle-templates', path);
        if (res.success) filesDeleted++;
      } catch { /* ignore — orphaned storage objects are harmless */ }
    }
  }

  for (const ids of chunk(toDelete.map(r => r.id), 100)) {
    const { error: delErr } = await supabase.from('vehicle_templates').delete().in('id', ids);
    if (delErr) return NextResponse.json({ error: `Delete failed: ${delErr.message}` }, { status: 500 });
  }
  for (const ids of chunk(toRetire.map(r => r.id), 100)) {
    const { error: retErr } = await supabase.from('vehicle_templates').update({ is_active: false }).in('id', ids);
    if (retErr) return NextResponse.json({ error: `Retire failed: ${retErr.message}` }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    deleted: toDelete.length,
    retired: toRetire.length,
    filesDeleted,
  });
}
