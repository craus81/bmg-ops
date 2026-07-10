import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { r2Delete } from '@/lib/r2';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DeleteSchema = z.object({
  templateId: z.string().uuid(),
});

/**
 * POST /api/admin/delete-template
 *
 * Force-deletes a single template. Unlike the bulk wipe (which retires
 * quote-referenced templates), this detaches any quotes/wrap_quotes pointing
 * at it (template_id -> null; the quotes keep their text and pricing), then
 * removes the stored preview/original files and the row itself.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DeleteSchema);
  if (parsed.error) return parsed.error;
  const id = parsed.data.templateId;

  const { data: row, error } = await supabase
    .from('vehicle_templates')
    .select('id, template_image_path, original_file_path')
    .eq('id', id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'Template not found' }, { status: 404 });

  // Detach wrap-quote references so the row delete can't hit an FK violation.
  const { data: upd, error: updErr } = await supabase
    .from('wrap_quotes')
    .update({ template_id: null })
    .eq('template_id', id)
    .select('id');
  if (updErr) return NextResponse.json({ error: `Failed detaching wrap_quotes: ${updErr.message}` }, { status: 500 });
  const detached = (upd || []).length;

  // Best-effort storage cleanup (legacy full-URL paths are left alone).
  for (const path of [row.template_image_path, row.original_file_path]) {
    if (!path || path.startsWith('http')) continue;
    try { await r2Delete('vehicle-templates', path); } catch { /* orphans are harmless */ }
  }

  const { error: delErr } = await supabase.from('vehicle_templates').delete().eq('id', id);
  if (delErr) return NextResponse.json({ error: `Delete failed: ${delErr.message}` }, { status: 500 });

  return NextResponse.json({ success: true, detached });
}
