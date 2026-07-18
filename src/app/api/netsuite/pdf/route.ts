import { NextRequest, NextResponse } from 'next/server';
import { getNetSuitePdf } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';

export const maxDuration = 60;

/**
 * GET /api/netsuite/pdf?type=salesOrder|invoice|estimate&id=123
 * Generic PDF endpoint for any supported NetSuite transaction type.
 */
export async function GET(request: NextRequest) {
  const auth = await requireStaff(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') as 'salesOrder' | 'invoice' | 'estimate' | null;
  const id = searchParams.get('id');

  if (!type || !['salesOrder', 'invoice', 'estimate'].includes(type)) {
    return NextResponse.json(
      { success: false, error: 'Missing or invalid type parameter (salesOrder, invoice, or estimate)' },
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

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message || 'PDF generation failed' },
      { status: 500 }
    );
  }
}
