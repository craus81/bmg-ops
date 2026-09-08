import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { buildCostHistory, computeDrift, staleCostWorklist, type Buy } from '@/lib/part-cost-book';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Part cost book (R6-7). ?item= gives one part's buy history; no item
 * gives the stale-cost worklist — every catalog price that has drifted
 * from what the part actually costs now.
 *
 * Every buy already sat in the PO mirror and nothing read it back, so the
 * catalog's purchase_price aged silently while real costs moved.
 */

const norm = (s: string) => s.trim().toUpperCase();

async function loadBuys(itemNumbers: string[] | null): Promise<Map<string, Buy[]>> {
  const { data, error } = await fetchAllRows<any>((from, to) => {
    let q = service
      .from('netsuite_vendor_po_lines')
      .select('item_number, quantity, rate, po:netsuite_vendor_pos(tranid, vendor_name, trandate)')
      .not('rate', 'is', null)
      .gt('rate', 0)
      .order('id')
      .range(from, to);
    if (itemNumbers && itemNumbers.length > 0) q = q.in('item_number', itemNumbers);
    return q;
  });
  if (error) throw new Error(error.message);

  const by = new Map<string, Buy[]>();
  for (const l of data || []) {
    const key = norm(l.item_number || '');
    if (!key) continue;
    const arr = by.get(key) || [];
    arr.push({
      itemNumber: key,
      poTranid: l.po?.tranid || null,
      vendorName: l.po?.vendor_name || null,
      trandate: l.po?.trandate || null,
      quantity: Number(l.quantity) || 0,
      rate: Number(l.rate) || 0,
    });
    by.set(key, arr);
  }
  return by;
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, z.object({
    item: z.string().max(80).optional(),
    minorPct: z.coerce.number().min(1).max(100).optional(),
    materialPct: z.coerce.number().min(1).max(200).optional(),
  }));
  if (q.error) return q.error;

  try {
    // ── One part's history ────────────────────────────────────────────
    if (q.data.item) {
      const key = norm(q.data.item);
      const buys = (await loadBuys([key])).get(key) || [];
      const history = buildCostHistory(key, buys);
      const { data: part } = await service
        .from('netsuite_parts').select('item_number, purchase_price').eq('item_number', key).maybeSingle();
      return NextResponse.json({
        history,
        drift: computeDrift(history, part?.purchase_price != null ? Number(part.purchase_price) : null, {
          minorPct: q.data.minorPct, materialPct: q.data.materialPct,
        }),
      });
    }

    // ── The stale-cost worklist ───────────────────────────────────────
    const [{ data: parts, error: partsErr }, byItem] = await Promise.all([
      fetchAllRows<any>((from, to) => service
        .from('netsuite_parts')
        .select('item_number, display_name, purchase_price, vendor')
        .eq('is_active', true)
        .order('item_number').order('id')
        .range(from, to)),
      loadBuys(null),
    ]);
    if (partsErr) return NextResponse.json({ error: partsErr.message }, { status: 500 });

    const drifts = (parts || [])
      .filter((p: any) => byItem.has(norm(p.item_number)))
      .map((p: any) => {
        const key = norm(p.item_number);
        const history = buildCostHistory(key, byItem.get(key)!);
        return {
          ...computeDrift(history, p.purchase_price != null ? Number(p.purchase_price) : null, {
            minorPct: q.data.minorPct, materialPct: q.data.materialPct,
          }),
          displayName: p.display_name || null,
          vendor: p.vendor || null,
          weightedAvgRate: history.weightedAvgRate,
        };
      });

    const worklist = staleCostWorklist(drifts);
    return NextResponse.json({
      worklist: worklist.slice(0, 200),
      totals: {
        compared: drifts.length,
        material: worklist.filter(d => d.severity === 'material').length,
        minor: worklist.filter(d => d.severity === 'minor').length,
        // Parts we bought but whose catalog price was never set — a
        // different problem from drift, and worth its own count.
        noCatalogPrice: drifts.filter(d => d.catalogPrice == null).length,
      },
    });
  } catch (e: any) {
    console.error('cost history failed:', e);
    return NextResponse.json({ error: e?.message || 'Cost history failed' }, { status: 500 });
  }
}
