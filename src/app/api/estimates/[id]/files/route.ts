import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { r2PresignPut, r2Delete, r2PublicUrl } from '@/lib/r2';
import { MAX_ATTACHMENT_BYTES, attachmentLimitMb } from '@/lib/email-attachments';
import { ESTIMATE_FILE_PREFIX } from '@/lib/estimate-attachments';

export const dynamic = 'force-dynamic';

/**
 * Files a rep uploads onto an estimate to email the customer — pictures,
 * spec sheets, anything the estimate document itself doesn't carry
 * (estimate_files + R2 under the 'estimate-files' prefix, migration 250).
 * They stay on the estimate, so the approval send, the Email PDF send, and
 * every later follow-up offer the same picker instead of asking the rep to
 * find the file again.
 *
 * Uploads go browser → R2 via presigned PUT to dodge Vercel's ~4.5MB API
 * body limit, the same two-step the CRM's customer files use:
 *
 *   POST { action: 'presign', fileName, contentType, size }
 *     → { uploadUrl, path }        (browser PUTs the file to uploadUrl)
 *   POST { action: 'record', path, fileName, contentType, size }
 *     → { success, file }          (saves metadata after the PUT succeeds)
 *   GET                            → { success, files }
 *   DELETE ?fileId=<uuid>          → { success }  (removes R2 object + row)
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;

function service() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
}

const publicFields = 'id, file_name, content_type, size_bytes, public_url, created_at';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const estimateId = params.id;
  if (!UUID_RE.test(estimateId)) return NextResponse.json({ error: 'Invalid estimate id' }, { status: 400 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const fileName = safeFileName(String(body?.fileName || ''));
  const contentType = String(body?.contentType || 'application/octet-stream').slice(0, 100);
  const size = Number(body?.size) || 0;
  // A single file over the whole-email budget could never be sent, so it is
  // rejected at upload time rather than at the send that finally fails.
  if (size <= 0 || size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json({ error: `File must be under ${attachmentLimitMb()}MB — that's the limit for what an email can carry.` }, { status: 400 });
  }

  const supabase = service();
  const { data: estimate } = await supabase.from('estimates').select('id').eq('id', estimateId).maybeSingle();
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

  if (body.action === 'presign') {
    const path = `${estimateId}/${Date.now()}-${fileName}`;
    const { url } = await r2PresignPut(ESTIMATE_FILE_PREFIX, path, contentType);
    return NextResponse.json({ success: true, uploadUrl: url, path });
  }

  if (body.action === 'record') {
    const path = String(body?.path || '');
    // Only accept paths this route could have presigned for THIS estimate —
    // otherwise a crafted `path` could alias another estimate's object.
    if (!path.startsWith(`${estimateId}/`) || path.includes('..')) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }
    const { data, error } = await supabase.from('estimate_files').insert({
      estimate_id: estimateId,
      file_name: fileName,
      content_type: contentType,
      size_bytes: size,
      storage_path: path,
      public_url: r2PublicUrl(ESTIMATE_FILE_PREFIX, path),
      uploaded_by: auth.user?.id || null,
    }).select(publicFields).single();
    if (error || !data) {
      return NextResponse.json({ error: error?.message || 'Failed to save file record' }, { status: 500 });
    }
    return NextResponse.json({ success: true, file: data });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const estimateId = params.id;
  if (!UUID_RE.test(estimateId)) return NextResponse.json({ error: 'Invalid estimate id' }, { status: 400 });

  const { data, error } = await service().from('estimate_files')
    .select(publicFields)
    .eq('estimate_id', estimateId)
    .order('created_at', { ascending: false })
    .order('id')
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, files: data || [] });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const estimateId = params.id;
  const fileId = req.nextUrl.searchParams.get('fileId') || '';
  if (!UUID_RE.test(estimateId) || !UUID_RE.test(fileId)) {
    return NextResponse.json({ error: 'fileId required' }, { status: 400 });
  }

  const supabase = service();
  const { data: file } = await supabase
    .from('estimate_files')
    .select('id, storage_path')
    .eq('id', fileId)
    .eq('estimate_id', estimateId)
    .maybeSingle();
  if (!file) return NextResponse.json({ error: 'File not found on this estimate' }, { status: 404 });

  await r2Delete(ESTIMATE_FILE_PREFIX, file.storage_path);
  const { error } = await supabase.from('estimate_files').delete().eq('id', fileId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
