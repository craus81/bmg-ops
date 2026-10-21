import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { checkRateLimit, getRequestIp, validateExpiry } from '@/lib/magic-link-approval';
import { r2GetBytes } from '@/lib/r2';
import { ESTIMATE_FILE_PREFIX } from '@/lib/estimate-attachments';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';

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

  // The approval token is the credential, as on the approval page, and an
  // expired link gets nothing.
  const { data: estimate } = await supabase
    .from('estimates')
    .select('id, approval_token_expires_at, approval_file_ids')
    .eq('approval_token', params.token)
    .maybeSingle();
  if (!estimate) return new NextResponse(null, { status: 404 });
  if (!validateExpiry(estimate.approval_token_expires_at).ok) return new NextResponse(null, { status: 410 });
  const pinned: string[] = estimate.approval_file_ids || [];
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
