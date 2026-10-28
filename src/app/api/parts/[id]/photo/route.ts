import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

const Schema = z.object({
  /** R2 path (photos bucket) of the picture the browser just uploaded. */
  imagePath: z.string().trim().min(1).max(1000).regex(/^parts\//, 'Part photos live under parts/'),
});

// Set a part's catalog photo from its record on the Parts page — admins and
// Part Admin holders (Craig, 2026-10-28). FleetSuite-owned: the parts sync
// never touches image_path. There's deliberately no "remove": a photo is
// only ever replaced.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'part_admin');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { imagePath } = parsed.data;

  const supabase = createServiceClient();
  const { data: part, error: readErr } = await supabase
    .from('netsuite_parts')
    .select('id, item_number, image_path')
    .eq('id', params.id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!part) return NextResponse.json({ error: 'Part not found in the catalog' }, { status: 404 });

  const { error } = await supabase.from('netsuite_parts').update({ image_path: imagePath }).eq('id', part.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'netsuite_parts',
    recordId: part.id,
    action: 'part_photo_set',
    detail: { item_number: part.item_number, image_path_before: part.image_path, image_path_after: imagePath },
  });
  return NextResponse.json({ success: true, imagePath });
}
