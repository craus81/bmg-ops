import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { storageDownloadUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const Schema = z.object({
  /** With a part id: that part's install files. Without: the whole list. */
  partId: z.string().uuid().optional(),
});

/**
 * GET /api/parts/installer — the Installer Parts page's data (Craig,
 * 2026-10-20: "a parts catalog for installers with no pricing").
 *
 * The full Parts Catalog hides prices on screen but still sends them to the
 * browser with the rest of the row. This route is the price-free version:
 * the select lists only what an installer needs, so sale price, cost,
 * margin, vendor and installer pay never leave the server. Stock counts and
 * POs stay out too.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'installer_parts');
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, Schema);
  if (parsed.error) return parsed.error;
  const { partId } = parsed.data;

  if (partId) {
    const { data, error } = await supabase
      .from('part_files')
      .select('id, file_name, file_type, storage_path, bucket, label, sort_order, uploaded_at')
      .eq('part_id', partId)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('uploaded_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const files = (data || []).map(f => ({
      id: f.id,
      name: f.label || f.file_name,
      fileName: f.file_name,
      fileType: f.file_type,
      url: storageDownloadUrl(f.bucket || 'graphics-proofs', f.storage_path, f.file_name),
    }));
    return NextResponse.json({ files });
  }

  const parts: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('netsuite_parts')
      .select('id, item_number, display_name, description, catalog, labor_hours, image_path, marketing_description')
      .eq('is_active', true)
      .order('item_number')
      .order('id')
      .range(offset, offset + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    parts.push(...data);
    if (data.length < 1000) break;
  }

  return NextResponse.json({ parts });
}
