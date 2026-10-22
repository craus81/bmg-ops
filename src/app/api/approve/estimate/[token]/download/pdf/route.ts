import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { generateEstimatePdf } from '@/lib/estimate-pdf-server';
import { attachmentDisposition, resolveDownloadToken } from '@/lib/estimate-approval-downloads';

export const dynamic = 'force-dynamic';
// pdf-lib merges proofs and wrap assets page by page; the default budget
// can run out on a proof-heavy estimate.
export const maxDuration = 60;

const supabase = createServiceClient();

/**
 * GET /api/approve/estimate/[token]/download/pdf
 *
 * The estimate PDF — the same document the approval email attaches — for
 * a customer whose mail system stripped the attachment, or for whoever the
 * email was forwarded to. The send's token is the credential, good for a
 * year (resolveDownloadToken): the email no longer attaches the PDF, so
 * this link is the customer's copy.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!(await checkRateLimit(ip, 'approve_estimate_download'))) {
    return NextResponse.json({ error: 'Too many downloads, please wait and retry.' }, { status: 429 });
  }

  const found = await resolveDownloadToken(supabase, params.token, '');
  if (!found.ok) return new NextResponse(null, { status: found.status });
  const { estimate } = found;

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
