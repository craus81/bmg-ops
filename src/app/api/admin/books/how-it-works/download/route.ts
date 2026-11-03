import { NextRequest, NextResponse } from 'next/server';
import { getProfileRoles, requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';
import { loadHowItWorks } from '@/lib/books/how-it-works-data';
import { howItWorksPdf } from '@/lib/books/how-it-works-pdf';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/how-it-works/download — Books → How the books work as
 * a PDF dated now, for BMG's CPA to read and sign (src/lib/books/how-it-works-pdf.ts,
 * docs/books.md "How the books work"): the same words and facts as the page,
 * a box for the CPA's name, signature and date with the fingerprint of the
 * rules it covers, and the chart of accounts. No tax IDs or bank numbers.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;
  try {
    const file = howItWorksPdf(await loadHowItWorks(createServiceClient(), { roles: getProfileRoles(auth.profile) }));
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': file.type,
        'Content-Length': String(file.bytes.byteLength),
        'Content-Disposition': attachmentDisposition(file.name),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });
  }
}
