import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAuth, isInternalStaffRole } from '@/lib/api-auth';
import { r2Upload } from '@/lib/r2';
import { MAX_REQUEST_FILES, MAX_REQUEST_FILE_BYTES, REQUEST_FILES_PREFIX, canSeeRequest } from '@/lib/app-requests';
import { isUuid } from '@/lib/app-requests-server';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * POST /api/requests/[id]/files: one screenshot (multipart field "file")
 * onto a request the caller can see. The page shrinks phone screenshots to
 * a JPEG first; pictures only. Stored under app-requests/, which the
 * generic storage API refuses, and served back by /api/requests/files/[id].
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const viewer = { id: auth.user!.id, staff: isInternalStaffRole(auth.profile) };

  const { data: request } = await service.from('app_requests').select('id, created_by').eq('id', params.id).maybeSingle();
  if (!request || !canSeeRequest(viewer, request)) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

  const { count } = await service.from('app_request_files').select('id', { count: 'exact', head: true }).eq('request_id', params.id);
  if ((count || 0) >= MAX_REQUEST_FILES) {
    return NextResponse.json({ error: `A request holds ${MAX_REQUEST_FILES} screenshots at most.` }, { status: 400 });
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get('file');
    if (f && typeof f !== 'string') file = f as File;
  } catch { /* falls through to the error below */ }
  if (!file) return NextResponse.json({ error: 'No screenshot was sent.' }, { status: 400 });
  const ext = TYPES[(file.type || '').toLowerCase()];
  if (!ext) return NextResponse.json({ error: 'Only pictures (JPEG, PNG, WebP or GIF) can go on a request.' }, { status: 400 });
  if (file.size > MAX_REQUEST_FILE_BYTES) return NextResponse.json({ error: 'That picture is too big. Try a smaller screenshot.' }, { status: 413 });

  const path = `${params.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const up = await r2Upload(REQUEST_FILES_PREFIX, path, Buffer.from(await file.arrayBuffer()), file.type);
  if (!up.success) return NextResponse.json({ error: 'The screenshot did not upload: ' + (up.error || 'storage error') }, { status: 502 });

  const { data, error } = await service.from('app_request_files').insert({
    request_id: params.id,
    storage_path: path,
    file_name: (file.name || `screenshot.${ext}`).slice(0, 200),
    content_type: file.type,
    created_by: viewer.id,
  }).select('id, file_name, content_type, created_at').single();
  if (error || !data) return NextResponse.json({ error: error?.message || 'Could not save the screenshot' }, { status: 500 });

  return NextResponse.json({ file: { ...data, url: `/api/requests/files/${data.id}` } });
}
