import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { generateEstimatePdf } from '@/lib/estimate-pdf-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // line photos are fetched and inlined

function getSupabase() {
  return createServiceClient();
}

/**
 * GET /api/estimates/[id]/pdf — the FleetSuite enhanced-estimate copy as a
 * PDF, rendered server-side (src/lib/estimate-pdf-server.ts) so the viewed
 * file and the emailed attachment are the same bytes.
 *
 *   ?print=1    → autoPrint: the browser's PDF viewer opens its print dialog
 *   ?download=1 → attachment disposition instead of inline
 *   ?proforma=1 → the Pro Forma Invoice version (for a dealer's lender)
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const print = req.nextUrl.searchParams.get('print') === '1';
  const download = req.nextUrl.searchParams.get('download') === '1';
  const proForma = req.nextUrl.searchParams.get('proforma') === '1';

  const result = await generateEstimatePdf(getSupabase(), params.id, { print, proForma });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${result.filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
