import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { loadInventoryValue } from '@/lib/books/inventory-value-data';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/inventory-value?month=2026-10 — every company's
 * stock at the end of the month, item by item, and each inventory account
 * that day, the stocked items on it next to the balance sheet with every
 * cent between them named (src/lib/books/inventory-value.ts, migration
 * 495, docs/books.md "Inventory value at a month's end"); last month when
 * it's left out. Values are whole cents.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const loaded = await loadInventoryValue(createServiceClient(), new URL(req.url).searchParams);
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  return NextResponse.json(loaded);
}
