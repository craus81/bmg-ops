import { NextRequest, NextResponse } from 'next/server';
import { getInvoicePdf } from '@/lib/netsuite';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Missing id parameter' },
      { status: 400 }
    );
  }

  try {
    const result = await getInvoicePdf(id);

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
