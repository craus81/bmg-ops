import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { r2PresignPut, r2Delete, r2PublicUrl } from '@/lib/r2';

export const dynamic = 'force-dynamic';

/**
 * Files attached to a CRM/customer record (prospect_files + R2 under the
 * 'prospect-files' prefix). Uploads go browser → R2 via presigned PUT to
 * dodge Vercel's ~4.5MB API body limit:
 *
 *   POST { action: 'presign', prospectId, fileName, contentType, size }
 *     → { uploadUrl, path }          (browser PUTs the file to uploadUrl)
 *   POST { action: 'record', prospectId, path, fileName, contentType, size }
 *     → { success, file }            (saves metadata after the PUT succeeds)
 *   GET  ?prospectId=<uuid>          → { success, files }
 *   DELETE ?id=<uuid>                → { success }  (removes R2 object + row)
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_BYTES = 25 * 1024 * 1024;

function service() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
}

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const prospectId = String(body?.prospectId || '');
  if (!UUID_RE.test(prospectId)) return NextResponse.json({ error: 'prospectId required' }, { status: 400 });
  const fileName = safeFileName(String(body?.fileName || ''));
  const contentType = String(body?.contentType || 'application/octet-stream').slice(0, 100);
  const size = Number(body?.size) || 0;
  if (size <= 0 || size > MAX_BYTES) return NextResponse.json({ error: 'File must be under 25MB' }, { status: 400 });

  const supabase = service();
  const { data: prospect } = await supabase.from('prospects').select('id').eq('id', prospectId).maybeSingle();
  if (!prospect) return NextResponse.json({ error: 'Prospect not found' }, { status: 404 });

  if (body.action === 'presign') {
    const path = `${prospectId}/${Date.now()}-${fileName}`;
    const { url } = await r2PresignPut('prospect-files', path, contentType);
    return NextResponse.json({ success: true, uploadUrl: url, path });
  }

  if (body.action === 'record') {
    const path = String(body?.path || '');
    // Only accept paths this route could have presigned for this prospect —
    // otherwise a crafted `path` could alias someone else's object.
    if (!path.startsWith(`${prospectId}/`) || path.includes('..')) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }
    const { data, error } = await supabase.from('prospect_files').insert({
      prospect_id: prospectId,
      file_name: fileName,
      content_type: contentType,
      size_bytes: size,
      storage_path: path,
      public_url: r2PublicUrl('prospect-files', path),
      uploaded_by: auth.user?.id || null,
    }).select().single();
    if (error || !data) return NextResponse.json({ error: error?.message || 'Failed to save file record' }, { status: 500 });
    return NextResponse.json({ success: true, file: data });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const prospectId = req.nextUrl.searchParams.get('prospectId') || '';
  if (!UUID_RE.test(prospectId)) return NextResponse.json({ error: 'prospectId required' }, { status: 400 });

  const { data, error } = await service().from('prospect_files')
    .select('id, file_name, content_type, size_bytes, public_url, created_at')
    .eq('prospect_id', prospectId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, files: data || [] });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const id = req.nextUrl.searchParams.get('id') || '';
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = service();
  const { data: file } = await supabase.from('prospect_files').select('id, storage_path').eq('id', id).maybeSingle();
  if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 });

  await r2Delete('prospect-files', file.storage_path);
  const { error } = await supabase.from('prospect_files').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
