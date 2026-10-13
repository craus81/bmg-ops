import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp, validateExpiry } from '@/lib/magic-link-approval';
import { generateEstimatePdf } from '@/lib/estimate-pdf-server';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';

export const dynamic = 'force-dynamic';
// pdf-lib merges proofs and wrap assets page by page; the default budget
// can run out on a proof-heavy estimate.
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/approve/estimate/[token]/download/pdf
 *
 * The estimate PDF — the same document the approval email attaches — for
 * a customer whose mail system stripped the attachment, or for whoever the
 * email was forwarded to. Gated like the approval page: the live token is
 * the credential and an expired link gets nothing.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!(await checkRateLimit(ip, 'approve_estimate_download'))) {
    return NextResponse.json({ error: 'Too many downloads, please wait and retry.' }, { status: 429 });
  }

  // The approval token is the credential, as on the approval page, and an
  // expired link gets nothing.
  const { data: estimate } = await supabase
    .from('estimates')
    .select('id, approval_token_expires_at')
    .eq('approval_token', params.token)
    .maybeSingle();
  if (!estimate) return new NextResponse(null, { status: 404 });
  if (!validateExpiry(estimate.approval_token_expires_at).ok) return new NextResponse(null, { status: 410 });

  const pdf = await generateEstimatePdf(supabase, estimate.id);
  if (!pdf.ok) return NextResponse.json({ error: pdf.error }, { status: pdf.status === 404 ? 404 : 502 });

  return new NextResponse(new Uint8Array(pdf.buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.buffer.byteLength),
      'Content-Disposition': attachmentDisposition(pdf.filename),
      'Cache-Control': 'private, no-store',
    },
  });
}
