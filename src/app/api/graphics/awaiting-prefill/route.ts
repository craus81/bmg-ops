import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';
import { buildAwaitingPrefill, prefillNote, type PrefillCatalogEntry } from '@/lib/awaiting-graphics-prefill';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({ checkinId: z.string().uuid() });

/**
 * GET /api/graphics/awaiting-prefill?checkinId= (R6-10)
 *
 * The graphic lines on a queued vehicle's sales order, ready to drop into
 * the create-job wizard. Answers with an EMPTY prefill rather than an
 * error whenever the order can't be read — no SO linked, no mirror row
 * yet, a failed read — because "+ Create" must always open the wizard.
 * A prefill that fails is a wizard the person fills in by hand, exactly
 * as they do today; a prefill that throws is a button that stops working.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, Schema);
  if (parsed.error) return parsed.error;

  const empty = (note: string) => NextResponse.json({
    success: true,
    prefill: {
      partNumbers: [], matched: [], quantity: 1, quantityAmbiguous: false,
      content: '', linesRead: 0, skipped: 0, counts: { catalog: 0, prefix: 0 },
    },
    note,
  });

  const { data: checkin } = await supabase
    .from('fleet_checkins')
    .select('id, customer_name, sales_order_number, netsuite_sales_order_id, graphics_signal, vehicle_year, vehicle_make, vehicle_model')
    .eq('id', parsed.data.checkinId)
    .maybeSingle();
  if (!checkin) return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });
  if (!checkin.netsuite_sales_order_id && !checkin.sales_order_number) {
    return empty('This vehicle has no sales order linked, so there is nothing to pull in.');
  }

  // Id first, then number — the migration-085 handoff precedence.
  let soRow: any = null;
  if (checkin.netsuite_sales_order_id) {
    const { data } = await supabase.from('netsuite_sales_orders')
      .select('id').eq('netsuite_id', String(checkin.netsuite_sales_order_id)).maybeSingle();
    soRow = data;
  }
  if (!soRow && checkin.sales_order_number) {
    const { data } = await supabase.from('netsuite_sales_orders')
      .select('id').eq('tranid', checkin.sales_order_number).maybeSingle();
    soRow = data;
  }
  if (!soRow) {
    return empty(`Sales order ${checkin.sales_order_number || ''} hasn't come over from NetSuite yet, so its lines can't be read.`.trim());
  }

  const lineRead = await fetchAllRows<any>((from, to) => supabase
    .from('netsuite_sales_order_lines')
    .select('item_number, description, quantity')
    .eq('so_id', soRow.id)
    .order('id')
    .range(from, to));
  if (lineRead.error) return empty('The sales order’s lines could not be read.');

  const keys = [...new Set(lineRead.data.map(l => normalizeItemNumber(l.item_number)).filter(Boolean))];
  const catalog = new Map<string, PrefillCatalogEntry>();
  for (let i = 0; i < keys.length; i += 200) {
    const { data } = await supabase
      .from('netsuite_parts')
      .select('item_number, catalog, display_name, description')
      .in('item_number', keys.slice(i, i + 200));
    for (const c of data || []) catalog.set(normalizeItemNumber(c.item_number), c as PrefillCatalogEntry);
  }

  const prefill = buildAwaitingPrefill(lineRead.data, catalog);
  // The keyword signal that flagged this vehicle seeds the description —
  // it is the sentence a human already wrote about why graphics are due.
  prefill.content = String(checkin.graphics_signal || '').trim();

  return NextResponse.json({
    success: true,
    prefill,
    note: prefillNote(prefill),
    soNumber: checkin.sales_order_number || null,
  });
}
