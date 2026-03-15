import { NextRequest, NextResponse } from 'next/server';
import { getOpenSalesOrdersByCustomer } from '@/lib/netsuite';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const customer = searchParams.get('customer');

  if (!customer) {
    return NextResponse.json(
      { found: false, error: 'Missing customer parameter' },
      { status: 400 }
    );
  }

  try {
    const result = await getOpenSalesOrdersByCustomer(customer);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { found: false, error: e.message || 'NetSuite query failed' },
      { status: 500 }
    );
  }
}
