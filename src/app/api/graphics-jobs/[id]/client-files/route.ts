import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { CLIENT_FILE_ITEM_SELECT, toClientFileItem, type ClientFileItem } from '@/lib/client-file-item';

export const dynamic = 'force-dynamic';

/** A Client Files file linked onto a job; linkId removes it again. */
export interface JobClientFile extends ClientFileItem {
  linkId: string;
  /** Gone from Dropbox since it was linked: still listed so nobody wonders where it went. */
  deleted: boolean;
}

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

/**
 * /api/graphics-jobs/<id>/client-files — Dropbox client files linked onto a
 * graphics job (migration 417). Linked, not copied (Craig, 2026-10-20): they
 * open through /api/client-files/<id>, from FleetSuite's copy or Dropbox.
 *
 * GET lists them, oldest link first. POST { fileIds } links up to 50 at once
 * and skips ones already on the job. DELETE ?link=<linkId> unlinks one;
 * the Dropbox file is never touched. All internal staff.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const { data, error } = await createServiceClient().from('graphics_job_client_files')
    .select(`id, added_at, file:dropbox_client_files(${CLIENT_FILE_ITEM_SELECT}, deleted_at)`)
    .eq('job_id', params.id)
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
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;

  const service = createServiceClient();
  const { data: job } = await service.from('graphics_jobs').select('id').eq('id', params.id).maybeSingle();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const ids = Array.from(new Set(parsed.data.fileIds));
  const { error } = await service.from('graphics_job_client_files')
    .upsert(
      ids.map(client_file_id => ({ job_id: params.id, client_file_id, added_by: auth.user!.id })),
      { onConflict: 'job_id,client_file_id', ignoreDuplicates: true },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ linked: ids.length });
}

const DeleteSchema = z.object({ link: z.string().uuid() });

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const parsed = validateSearchParams(req, DeleteSchema);
  if (parsed.error) return parsed.error;

  const { error } = await createServiceClient().from('graphics_job_client_files')
    .delete().eq('id', parsed.data.link).eq('job_id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
