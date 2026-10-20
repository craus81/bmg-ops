import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { searchCustomerTransactions, TXN_SEARCH_MIN } from '@/lib/customer-txn-search';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/customers/transaction-search?nsId=&q=
 *
 * The customer page's Transactions search box: this NetSuite customer's
 * invoices, credit memos, sales orders and estimates (plus FleetSuite
 * estimates) whose lines, memo, PO or VIN match. Staff, like the NetSuite
 * document list the box filters (/api/netsuite/customer-invoices).
 * Rules: src/lib/customer-txn-search.ts.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const sp = req.nextUrl.searchParams;
  const nsId = (sp.get('nsId') || '').trim();
  if (!/^\d{1,15}$/.test(nsId)) return NextResponse.json({ error: 'Bad nsId' }, { status: 400 });
  const q = (sp.get('q') || '').trim().slice(0, 100);
  if (q.length < TXN_SEARCH_MIN) return NextResponse.json({ success: true, hits: [] });

  try {
    const hits = await searchCustomerTransactions(createServiceClient(), nsId, q);
    return NextResponse.json({ success: true, hits });
  } catch (err: any) {
    console.error('customer transaction search failed:', err);
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
