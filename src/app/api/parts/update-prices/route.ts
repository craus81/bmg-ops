import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { logAudit } from '@/lib/audit';
import { planPriceUpdates, sameMoney, type CatalogPriceRow, type PriceUpdateResult } from '@/lib/price-update-import';
import { isRealNetsuiteId, writePricesToNetsuite } from '@/lib/part-netsuite-write';
import { clearMismatch, noteRefusedPrice } from '@/lib/price-mismatch';

export const dynamic = 'force-dynamic';
// Each saved part is a NetSuite round-trip; the page sends 20 parts a call.
export const maxDuration = 60;

const supabase = createServiceClient();

const Schema = z.object({
  /** false = preview only; true = save (at most 25 parts a call). */
  apply: z.boolean(),
  rows: z.array(z.object({
    partNumber: z.string().trim().min(1).max(80),
    price: z.number().positive().max(10_000_000).nullable().optional(),
    cost: z.number().nonnegative().max(10_000_000).nullable().optional(),
  })).min(1).max(5000),
});

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

type Row = CatalogPriceRow & { netsuite_id: string | null };

/**
 * POST /api/parts/update-prices: Admin → Update Prices (migration 513).
 * Loads new selling prices and/or costs onto catalog parts by part number.
 * apply:false previews what changes; apply:true saves each part in FleetSuite
 * and sends it to NetSuite (item RESTlet), so the two stay the same.
 *
 * As on the one-part edit: a price NetSuite refuses still saves in FleetSuite
 * (FleetSuite's price is the one that counts) and goes on "Prices that don't
 * match"; a cost NetSuite refuses is not saved, because the parts sync would
 * put NetSuite's back. A blank price or cost keeps what the part has.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { apply, rows } = parsed.data;
  if (apply && rows.length > 25) {
    return NextResponse.json({ error: 'Save at most 25 parts at a time.' }, { status: 400 });
  }

  const { data: catalog, error } = await fetchAllRows<Row>((from, to) =>
    supabase.from('netsuite_parts')
      .select('id, netsuite_id, item_number, display_name, is_active, sales_price, purchase_price')
      .order('item_number').order('id')
      .range(from, to),
  );
  if (error) return NextResponse.json({ error: `Couldn't read the parts catalog: ${error.message}` }, { status: 500 });

  const results = planPriceUpdates(rows, catalog);
  if (!apply) return NextResponse.json({ results });

  const byId = new Map(catalog.map(p => [p.id, p]));
  const toSave = results.filter(r => r.status === 'change');
  const failed: { partNumber: string; error: string }[] = [];

  const saveOne = async (r: PriceUpdateResult) => {
    const rowsFor = r.partIds.map(id => byId.get(id)!).filter(Boolean);
    const shown = rowsFor.find(m => m.is_active) || rowsFor[0];
    const patch: { sales_price?: number; purchase_price?: number } = {};
    if (r.next.price !== null && rowsFor.some(m => !sameMoney(num(m.sales_price), r.next.price))) patch.sales_price = r.next.price;
    if (r.next.cost !== null && rowsFor.some(m => !sameMoney(num(m.purchase_price), r.next.cost))) patch.purchase_price = r.next.cost;
    if (Object.keys(patch).length === 0) { r.saved = { netsuite: 'not_netsuite' }; return; }

    // Every NetSuite item behind this part number (normally one).
    const nsIds = [...new Set(rowsFor.map(m => m.netsuite_id).filter(isRealNetsuiteId))];
    const missed = new Set<string>();
    let reason: string | null = null;
    for (const nsId of nsIds) {
      const out = await writePricesToNetsuite(nsId, patch);
      out.notInNetsuite.forEach(c => missed.add(c));
      reason = reason || out.reason;
    }

    const applied: Record<string, number> = { ...patch };
    const notes: string[] = [];
    if (missed.has('purchase_price')) {
      delete applied.purchase_price;
      notes.push('Cost not saved: NetSuite didn’t take it, and the parts sync would put NetSuite’s back.');
    }
    if (missed.has('sales_price')) notes.push('Price saved in FleetSuite, but NetSuite didn’t take it. It’s on "Prices that don’t match".');

    if (Object.keys(applied).length > 0) {
      const { error: upErr } = await supabase.from('netsuite_parts')
        .update({ ...applied, updated_at: new Date().toISOString() })
        .in('id', r.partIds);
      if (upErr) { failed.push({ partNumber: r.partNumber, error: upErr.message }); return; }
    }

    if (patch.sales_price !== undefined && shown && nsIds.length > 0) {
      if (missed.has('sales_price')) {
        await noteRefusedPrice(supabase, { part_id: shown.id, item_number: r.partNumber, fleetsuite_price: patch.sales_price, reason: reason ? `NetSuite didn't take the upload. ${reason}` : "NetSuite didn't take the upload" });
      } else {
        await clearMismatch(supabase, r.partIds);
      }
    }

    r.saved = {
      netsuite: nsIds.length === 0 ? 'not_netsuite' : missed.size > 0 ? 'failed' : 'sent',
      ...(notes.length ? { note: [reason, ...notes].filter(Boolean).join(' ') } : {}),
    };

    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'netsuite_parts',
      recordId: shown?.id || r.partIds[0],
      action: 'update',
      detail: {
        item_number: r.partNumber,
        via: 'update_prices',
        before: { sales_price: r.current?.price ?? null, purchase_price: r.current?.cost ?? null },
        after: applied,
        syncedToNetsuite: nsIds.length > 0 && missed.size === 0,
        ...(missed.size ? { netsuiteWarning: reason } : {}),
      },
    });
  };

  for (let i = 0; i < toSave.length; i += 4) {
    await Promise.all(toSave.slice(i, i + 4).map(r => saveOne(r).catch((e: any) => {
      failed.push({ partNumber: r.partNumber, error: e?.message || String(e) });
    })));
  }

  return NextResponse.json({ results, failed });
}
