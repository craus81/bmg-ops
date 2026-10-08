import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import type { VendorCostResult } from '@/lib/vendor-cost-import';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  /** false = preview only; true = write the changes. */
  apply: z.boolean(),
  rows: z.array(z.object({
    partNumber: z.string().trim().min(1).max(80),
    vendor: z.string().trim().max(200).nullable().optional(),
    vendorCost: z.number().nonnegative().max(1_000_000).nullable().optional(),
    marginPct: z.number().gt(-100).lt(100).nullable().optional(),
  })).min(1).max(5000),
});

interface CatalogRow {
  id: string;
  item_number: string;
  display_name: string | null;
  is_active: boolean;
  sales_price: number | null;
  outsource_vendor: string | null;
  vendor_cost: number | null;
  target_margin_pct: number | null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * POST /api/parts/vendor-costs: load vendor cost, target margin and vendor
 * onto catalog parts by part number (Admin → Vendor Costs, migration 353).
 * FleetSuite only: nothing goes to NetSuite, and sales prices are untouched.
 * A blank cell keeps what the part already has. Preview first (apply:false)
 * to see what matches and what changes, then apply:true writes it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { apply, rows } = parsed.data;

  const { data: parts, error } = await fetchAllRows<CatalogRow>((from, to) =>
    supabase.from('netsuite_parts')
      .select('id, item_number, display_name, is_active, sales_price, outsource_vendor, vendor_cost, target_margin_pct')
      .order('item_number').order('id')
      .range(from, to),
  );
  if (error) return NextResponse.json({ error: `Couldn't read the parts catalog: ${error.message}` }, { status: 500 });

  const byNumber = new Map<string, CatalogRow[]>();
  for (const p of parts) {
    const key = String(p.item_number || '').trim().toUpperCase();
    if (!key) continue;
    byNumber.set(key, [...(byNumber.get(key) || []), p]);
  }

  // Last row wins when the sheet lists a part twice (the page flags it too).
  const wanted = new Map<string, (typeof rows)[number]>();
  for (const r of rows) wanted.set(r.partNumber.toUpperCase(), r);

  const results: VendorCostResult[] = [];
  wanted.forEach((r, key) => {
    const matches = byNumber.get(key) || [];
    // Show the active row's current values; inactive duplicates follow along.
    const shown = matches.find(m => m.is_active) || matches[0];
    const current = shown
      ? { vendor: shown.outsource_vendor, vendorCost: num(shown.vendor_cost), marginPct: num(shown.target_margin_pct) }
      : null;
    const next = {
      vendor: r.vendor ? r.vendor : current?.vendor ?? null,
      vendorCost: r.vendorCost ?? current?.vendorCost ?? null,
      marginPct: r.marginPct ?? current?.marginPct ?? null,
    };
    const differs = (m: CatalogRow) =>
      (m.outsource_vendor || null) !== next.vendor
      || num(m.vendor_cost) !== next.vendorCost
      || num(m.target_margin_pct) !== next.marginPct;
    results.push({
      partNumber: key,
      status: !shown ? 'not_found' : matches.some(differs) ? 'update' : 'same',
      partIds: matches.map(m => m.id),
      displayName: shown?.display_name ?? null,
      salesPrice: shown ? num(shown.sales_price) : null,
      current,
      next,
    });
  });

  if (!apply) return NextResponse.json({ results });

  const toWrite = results.filter(r => r.status === 'update');
  const now = new Date().toISOString();
  const failed: { partNumber: string; error: string }[] = [];
  for (let i = 0; i < toWrite.length; i += 10) {
    await Promise.all(toWrite.slice(i, i + 10).map(async r => {
      const { error: upErr } = await supabase.from('netsuite_parts').update({
        outsource_vendor: r.next.vendor,
        vendor_cost: r.next.vendorCost,
        target_margin_pct: r.next.marginPct,
        vendor_cost_updated_at: now,
        vendor_cost_updated_by: auth.user?.id || null,
      }).in('id', r.partIds);
      if (upErr) failed.push({ partNumber: r.partNumber, error: upErr.message });
    }));
  }

  return NextResponse.json({
    results,
    updated: toWrite.length - failed.length,
    failed,
  });
}
