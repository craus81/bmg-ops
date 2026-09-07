import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/netsuite-dupes — the LOOK-FIRST half of the unique-index
 * program (§7.4 item 12): which NetSuite-id money columns hold duplicated
 * ids in production. Migration 264 only creates each unique index when its
 * column is clean, so this report is how someone finds and fixes the rows
 * that keep an index from building — clean the duplicates here, redeploy,
 * and the migration (idempotent) creates the index on the next run.
 *
 * Read-only. PostgREST can't GROUP BY, so each column's non-null ids are
 * paginated down and counted here — id columns only, small payloads.
 */
const TARGETS: { table: string; column: string; label: string; indexed_by?: string }[] = [
  { table: 'customers', column: 'netsuite_id', label: 'Customers mirror — NetSuite customer id (promote-prospect upserts on this)' },
  { table: 'prospects', column: 'netsuite_id', label: 'CRM records — NetSuite customer id', indexed_by: 'migration 060' },
  { table: 'estimates', column: 'netsuite_estimate_id', label: 'Estimates — NetSuite estimate id' },
  { table: 'estimates', column: 'netsuite_so_id', label: 'Estimates — NetSuite sales order id' },
];

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const results = [];
  for (const t of TARGETS) {
    const { data: rows, error } = await fetchAllRows<Record<string, unknown>>((from, to) =>
      supabase
        .from(t.table)
        .select(`id, ${t.column}`)
        .not(t.column, 'is', null)
        .order('id')
        .range(from, to) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
    );
    if (error) {
      results.push({ ...t, error: error.message, total: rows.length, duplicatedIds: [] });
      continue;
    }
    const byValue = new Map<string, string[]>();
    for (const r of rows) {
      const v = String(r[t.column]);
      byValue.set(v, [...(byValue.get(v) || []), String(r.id)]);
    }
    const duplicatedIds = [...byValue.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([value, ids]) => ({ value, count: ids.length, rowIds: ids.slice(0, 10) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);
    results.push({ ...t, total: rows.length, duplicatedIds });
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    columns: results,
    clean: results.every(r => !('error' in r && r.error) && r.duplicatedIds.length === 0),
    note: 'Migration 264 creates each unique index automatically on the next production deploy once its column is clean.',
  });
}
