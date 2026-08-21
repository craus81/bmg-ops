import { NextRequest, NextResponse } from 'next/server';
import {
  getOpenSalesOrdersByCustomer,
  SALES_ORDER_SEARCH_TYPES,
  type SalesOrderSearchType,
} from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const auth = await requireStaff(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const customer = searchParams.get('customer');

  if (!customer) {
    return NextResponse.json(
      { found: false, error: 'Missing customer parameter' },
      { status: 400 }
    );
  }

  // Paged (default 20 per page) with an optional record-type filter —
  // `types` is comma-separated SuiteQL type ids (SalesOrd,CustInvc,Estimate).
  const limit = parseInt(searchParams.get('limit') || '', 10);
  const offset = parseInt(searchParams.get('offset') || '', 10);
  const types = (searchParams.get('types') || '')
    .split(',')
    .map(t => t.trim())
    .filter((t): t is SalesOrderSearchType =>
      (SALES_ORDER_SEARCH_TYPES as readonly string[]).includes(t));

  try {
    const result = await getOpenSalesOrdersByCustomer(customer, {
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      types,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { found: false, error: e.message || 'NetSuite query failed' },
      { status: 500 }
    );
  }
}
