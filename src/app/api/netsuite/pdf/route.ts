import { NextRequest, NextResponse } from 'next/server';
import { getNetSuitePdf } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';

export const maxDuration = 60;

/**
 * GET /api/netsuite/pdf?type=salesOrder|invoice|estimate|purchaseOrder|creditMemo&id=123
 * Generic PDF endpoint for any supported NetSuite transaction type.
 *
 * Answers JSON ({ success, pdfBase64 }) by default. `&format=pdf` answers
 * the PDF itself, inline, so the in-app viewer (deepLinks.netsuitePdf →
 * deepLinks.pdfViewer) can show it — the top bar opens a NetSuite estimate
 * that way, and the Purchasing page a PO. `&name=` sets the saved file name.
 */
export async function GET(request: NextRequest) {
  const auth = await requireStaff(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') as 'salesOrder' | 'invoice' | 'estimate' | 'purchaseOrder' | 'creditMemo' | null;
  const id = searchParams.get('id');

  if (!type || !['salesOrder', 'invoice', 'estimate', 'purchaseOrder', 'creditMemo'].includes(type)) {
    return NextResponse.json(
      { success: false, error: 'Missing or invalid type parameter (salesOrder, invoice, estimate, purchaseOrder or creditMemo)' },
      { status: 400 }
    );
  }

  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Missing id parameter' },
      { status: 400 }
    );
  }

  try {
    const result = await getNetSuitePdf(type, id);

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }

    if (searchParams.get('format') === 'pdf' && result.pdfBase64) {
      const bytes = Buffer.from(result.pdfBase64, 'base64');
      // `name` is the caller's file name (a PO's number, PO452.pdf);
      // NetSuite's own names a PO by its internal id only.
      const asked = (searchParams.get('name') || '').trim();
      let filename = (asked || result.filename || `${type}-${id}.pdf`).replace(/[^A-Za-z0-9._-]+/g, '_');
      if (!/\.pdf$/i.test(filename)) filename += '.pdf';
      return new NextResponse(bytes, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${filename}"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message || 'PDF generation failed' },
      { status: 500 }
    );
  }
}
