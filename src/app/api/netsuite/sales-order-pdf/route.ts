import { NextRequest, NextResponse } from 'next/server';
import { getNetSuitePdf } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

/** @deprecated Use /api/netsuite/pdf?type=salesOrder&id=... instead */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Missing id parameter' },
      { status: 400 }
    );
  }

  try {
    const result = await getNetSuitePdf('salesOrder', id);

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
