import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { validateExpiry } from '@/lib/magic-link-approval';
import { r2GetBytes } from '@/lib/r2';
import { isShrinkableImage, shrinkImageForEmail } from '@/lib/email-image';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';
import { jobCoversEstimate } from '@/lib/graphics-fleet';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MAX_PROOF_BYTES = 10 * 1024 * 1024;

/**
 * GET /api/approve/estimate/[token]/proof/[fileId]
 *
 * One graphic proof for the approval EMAIL, served from our own domain.
 * The email used to point its <img> tags at 7-day presigned links on
 * <account>.r2.cloudflarestorage.com — long signed URLs to a domain that
 * isn't ours, which spam filters score like phishing. Gated exactly like
 * the approval page: the live approval token, and only a file the estimate
 * actually attaches (graphics_jobs.estimate_attach).
 *
 * Inline (the email's picture): image types only, shrunk to email size.
 * `?download=1` (the approval page's Downloads list): the original file,
 * PDF proofs included, as a download.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string; fileId: string } }) {
  const download = req.nextUrl.searchParams.get('download') === '1';

  // The approval token is the credential, as on the approval page, and an
  // expired link gets nothing.
  const { data: estimate } = await supabase
    .from('estimates')
    .select('id, fleet_group_id, approval_token_expires_at')
    .eq('approval_token', params.token)
    .maybeSingle();
  if (!estimate) return new NextResponse(null, { status: 404 });
  if (!validateExpiry(estimate.approval_token_expires_at).ok) return new NextResponse(null, { status: 410 });

  const { data: file } = await supabase
    .from('graphics_job_files')
    .select('id, job_id, file_name, file_type, storage_path')
    .eq('id', params.fileId)
    .maybeSingle();
  if (!file?.storage_path) return new NextResponse(null, { status: 404 });

  const { data: job } = await supabase
    .from('graphics_jobs')
    .select('id, estimate_id, fleet_group_id, estimate_attach')
    .eq('id', file.job_id)
    .maybeSingle();
  const attached = Array.isArray(job?.estimate_attach?.file_ids) && job!.estimate_attach.file_ids.includes(file.id);
  if (!job || !jobCoversEstimate(job, estimate) || !attached) return new NextResponse(null, { status: 404 });

  const asset = await r2GetBytes('graphics-proofs', file.storage_path, MAX_PROOF_BYTES);
  if (!asset) return new NextResponse(null, { status: 404 });
  const contentType = asset.contentType || file.file_type || 'application/octet-stream';

  if (download) {
    return new NextResponse(new Uint8Array(asset.bytes), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(asset.bytes.byteLength),
        'Content-Disposition': attachmentDisposition(file.file_name),
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const imageType = isShrinkableImage(asset.contentType) ? asset.contentType : (file.file_type || '');
  if (!isShrinkableImage(imageType)) return new NextResponse(null, { status: 415 });
  const small = await shrinkImageForEmail(asset.bytes, imageType);
  return new NextResponse(new Uint8Array(small.bytes), {
    headers: {
      'Content-Type': small.contentType,
      'Content-Length': String(small.bytes.byteLength),
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
