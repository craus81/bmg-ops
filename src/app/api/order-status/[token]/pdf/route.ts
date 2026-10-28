import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { generateEstimatePdf } from '@/lib/estimate-pdf-server';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';
import { resolveOrderStatusToken } from '@/lib/order-status-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createServiceClient();

/**
 * GET /api/order-status/[token]/pdf — the approved estimate's PDF from the
 * customer's Order status page. Same credential as the page (the link's
 * token), rate-limited per IP.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!(await checkRateLimit(ip, 'order_status_pdf'))) {
    return NextResponse.json({ error: 'Too many downloads, please wait and retry.' }, { status: 429 });
  }

  const estimate = await resolveOrderStatusToken(supabase, params.token);
  if (!estimate) return new NextResponse(null, { status: 404 });

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
