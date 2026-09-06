import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { generateWrapQuotePdf } from '@/lib/wrap-quote-pdf-server';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * GET /api/wrap-quote/[id]/pdf — the FleetSuite copy of a wrap quote as a
 * PDF, built from the shared quote-document model (the same rows the
 * customer's email and the signed snapshot render), so the Transactions
 * list on a customer record can hand out the FleetSuite document next to
 * NetSuite's own PDF. Same bytes the quote email and follow-up attach
 * (generateWrapQuotePdf in src/lib/wrap-quote-pdf-server.ts).
 *
 *   ?print=1    → autoPrint: the browser's PDF viewer opens its print dialog
 *   ?download=1 → attachment disposition instead of inline
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const print = req.nextUrl.searchParams.get('print') === '1';
  const result = await generateWrapQuotePdf(getSupabase(), params.id, { print });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const download = req.nextUrl.searchParams.get('download') === '1';
  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${result.filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
