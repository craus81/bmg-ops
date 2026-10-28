import { NextRequest, NextResponse } from 'next/server';
import { requireFeature } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { CLIENT_FILE_ITEM_SELECT, toClientFileItem } from '@/lib/client-file-item';
import type { JobClientFile } from '@/app/api/graphics-jobs/[id]/client-files/route';

export const dynamic = 'force-dynamic';

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

/**
 * /api/estimates/<id>/client-files — Dropbox client files linked onto an
 * estimate (migration 448), the estimate twin of the graphics job one.
 * Linked, not copied (Craig, 2026-10-28): mostly dropped there from Client
 * Files on the other side of split screen.
 *
 * GET lists them, oldest link first. POST { fileIds } links up to 50 at once
 * and skips ones already on the estimate. DELETE ?link=<linkId> unlinks one;
 * the Dropbox file is never touched. Anyone with Estimates.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const { data, error } = await createServiceClient().from('estimate_client_files')
    .select(`id, added_at, file:dropbox_client_files(${CLIENT_FILE_ITEM_SELECT}, deleted_at)`)
    .eq('estimate_id', params.id)
    .order('added_at', { ascending: true })
    .order('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const files: JobClientFile[] = (data || [])
    .filter((r: any) => r.file)
    .map((r: any) => ({ ...toClientFileItem(r.file), linkId: r.id, deleted: !!r.file.deleted_at }));
  return NextResponse.json({ files });
}

const PostSchema = z.object({
  fileIds: z.array(z.string().uuid()).min(1).max(50),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;

  const service = createServiceClient();
  const { data: estimate } = await service.from('estimates').select('id').eq('id', params.id).maybeSingle();
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

  const ids = Array.from(new Set(parsed.data.fileIds));
  const { error } = await service.from('estimate_client_files')
    .upsert(
      ids.map(client_file_id => ({ estimate_id: params.id, client_file_id, added_by: auth.user!.id })),
      { onConflict: 'estimate_id,client_file_id', ignoreDuplicates: true },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ linked: ids.length });
}

const DeleteSchema = z.object({ link: z.string().uuid() });

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const parsed = validateSearchParams(req, DeleteSchema);
  if (parsed.error) return parsed.error;

  const { error } = await createServiceClient().from('estimate_client_files')
    .delete().eq('id', parsed.data.link).eq('estimate_id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
