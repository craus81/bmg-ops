import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { r2GetBytes } from '@/lib/r2';
import { ESTIMATE_FILE_PREFIX } from '@/lib/estimate-attachments';
import { attachmentDisposition, resolveDownloadToken } from '@/lib/estimate-approval-downloads';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * GET /api/approve/estimate/[token]/download/file/[fileId]
 *
 * One of the files the rep attached to the approval email, at full size.
 * Only files pinned on the estimate at send time (approval_file_ids) are
 * served — the token proves the customer was sent this estimate, and the
 * pin proves this file came with it.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string; fileId: string } }) {
  const ip = getRequestIp(req);
  if (!(await checkRateLimit(ip, 'approve_estimate_download', 60))) {
    return NextResponse.json({ error: 'Too many downloads, please wait and retry.' }, { status: 429 });
  }

  // The send's token is the credential, good for a year
  // (resolveDownloadToken), with the files that send carried.
  const found = await resolveDownloadToken(supabase, params.token, '');
  if (!found.ok) return new NextResponse(null, { status: found.status });
  const { estimate } = found;
  const pinned: string[] = found.fileIds;
  if (!pinned.includes(params.fileId)) return new NextResponse(null, { status: 404 });

  const { data: file } = await supabase
    .from('estimate_files')
    .select('id, estimate_id, file_name, file_type, storage_path')
    .eq('id', params.fileId)
    .maybeSingle();
  if (!file?.storage_path || file.estimate_id !== estimate.id) return new NextResponse(null, { status: 404 });

  const asset = await r2GetBytes(ESTIMATE_FILE_PREFIX, file.storage_path, MAX_FILE_BYTES);
  if (!asset) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(asset.bytes), {
    headers: {
      'Content-Type': file.file_type || asset.contentType || 'application/octet-stream',
      'Content-Length': String(asset.bytes.byteLength),
      'Content-Disposition': attachmentDisposition(file.file_name),
      'Cache-Control': 'private, no-store',
    },
  });
}
