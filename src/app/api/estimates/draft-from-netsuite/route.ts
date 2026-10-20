import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase-service';
import { profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { looseItemRegex, summarize, type DraftLine } from '@/lib/paste-to-estimate';
import {
  NETSUITE_COPY_LABEL, NETSUITE_COPY_TYPES, invoiceLineAmount, matchNetsuiteLine, nsItemNumber, netsuiteDraftRequests, sourceLineFromRow,
  type NetsuiteCatalogPart, type NetsuiteCopyType, type NetsuiteSourceDoc,
} from '@/lib/netsuite-estimate-copy';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({
  type: z.enum(NETSUITE_COPY_TYPES as [NetsuiteCopyType, ...NetsuiteCopyType[]]),
  netsuiteId: z.string().regex(/^\d+$/),
});

/** A build longer than this is added by hand past the cut, and says so. */
const MAX_LINES = 80;

const PART_FIELDS =
  'id, netsuite_id, item_number, display_name, description, sales_price, labor_hours, catalog, purchase_price, avg_install_cost, is_active';

interface Loaded {
  doc: NetsuiteSourceDoc;
  customerNetsuiteId: string | null;
}

/**
 * The old document from FleetSuite's own copy of it: sales orders and
 * estimates from their NetSuite copies (migrations 196, 372), invoices from
 * the ledger mirror (migration 314). No live NetSuite call.
 */
async function loadDoc(service: SupabaseClient, type: NetsuiteCopyType, nsId: string): Promise<Loaded | null> {
  const label = NETSUITE_COPY_LABEL[type];
  if (type === 'invoice') {
    const { data: head } = await service
      .from('ledger_invoices')
      .select('id, doc_number, doc_date, customer_netsuite_id')
      .eq('source', 'netsuite').eq('doc_type', 'invoice').eq('external_ref', nsId)
      .is('deleted_at', null)
      .maybeSingle();
    if (!head) return null;
    const { data: lines } = await service
      .from('ledger_invoice_lines')
      // The mirror stores amounts unsigned; NetSuite's own signed amount in
      // `raw` is what tells a discount line apart. NetSuite signs invoice
      // lines as credits (a sold part is negative, a discount positive), so
      // it's flipped here the way every invoice report does (-tl.netamount).
      .select('item_external_id, item_name, item_number, description, quantity, unit_price, amount, line_kind, line_no, ns_amount:raw->>netamount')
      .eq('document_id', head.id)
      .eq('line_kind', 'item')
      .order('line_no', { ascending: true, nullsFirst: false });
    return {
      doc: { number: head.doc_number || nsId, typeLabel: label, date: head.doc_date || '', lines: (lines || []).map((l: any) => sourceLineFromRow({ ...l, amount: invoiceLineAmount(l.ns_amount, l.amount) })) },
      customerNetsuiteId: head.customer_netsuite_id || null,
    };
  }

  const [headTable, lineTable, fk] = type === 'salesOrder'
    ? ['netsuite_sales_orders', 'netsuite_sales_order_lines', 'so_id']
    : ['netsuite_estimates', 'netsuite_estimate_lines', 'ns_estimate_id'];
  const { data: head } = await service
    .from(headTable)
    .select('id, tranid, trandate, customer_netsuite_id')
    .eq('netsuite_id', nsId)
    .maybeSingle();
  if (!head) return null;
  // line_id is NetSuite's transactionline id, which runs in line order.
  const { data: lines } = await service
    .from(lineTable)
    .select('line_id, item_netsuite_id, item_number, description, quantity, rate, amount')
    .eq(fk, head.id);
  const ordered = (lines || []).sort((a: any, b: any) => Number(a.line_id) - Number(b.line_id));
  return {
    doc: { number: head.tranid || nsId, typeLabel: label, date: head.trandate || '', lines: ordered.map(sourceLineFromRow) },
    customerNetsuiteId: head.customer_netsuite_id || null,
  };
}

/**
 * POST /api/estimates/draft-from-netsuite — turn a NetSuite invoice, sales
 * order or estimate into the builder's review grid (src/lib/netsuite-
 * estimate-copy.ts). Same response shape as draft-from-quickbooks, plus
 * `skipped` (labor and discount lines left off) and the customer, so a copy
 * started from search lands on the right account.
 *
 * Writes nothing: lines reach an estimate only when the rep accepts them in
 * the builder. Estimates feature, and the money wall on top, because the
 * grid carries the old document's prices.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) {
    return NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 });
  }

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { type, netsuiteId } = parsed.data;

  const service = createServiceClient();
  try {
    const loaded = await loadDoc(service, type, netsuiteId);
    if (!loaded) {
      return NextResponse.json({
        error: `FleetSuite doesn't have a copy of that NetSuite ${NETSUITE_COPY_LABEL[type].toLowerCase()} yet. New ones copy over every two hours.`,
      }, { status: 404 });
    }
    const { doc, customerNetsuiteId } = loaded;

    const { requests: all, skipped } = netsuiteDraftRequests(doc);
    const requests = all.slice(0, MAX_LINES);

    // One catalog read for every line: by NetSuite item id, and by number
    // for lines whose id the catalog doesn't carry.
    const ids = [...new Set(requests.map(r => r.line.itemNetsuiteId).filter((v): v is string => !!v))];
    const numbers = [...new Set(requests.map(r => r.line.itemNumber).filter((v): v is string => !!v))];
    const catalog: NetsuiteCatalogPart[] = [];
    if (ids.length > 0) {
      const { data } = await service.from('netsuite_parts').select(PART_FIELDS).in('netsuite_id', ids);
      catalog.push(...((data as NetsuiteCatalogPart[]) || []));
    }
    if (numbers.length > 0) {
      const { data } = await service.from('netsuite_parts').select(PART_FIELDS).in('item_number', numbers);
      for (const p of (data as NetsuiteCatalogPart[]) || []) if (!catalog.some(c => c.id === p.id)) catalog.push(p);
    }
    // Numbers still unfound: look for the same characters with different
    // punctuation (RB148 / RB-148), offered only as unticked suggestions.
    const unfound = numbers.filter(n => !catalog.some(c => nsItemNumber(c.item_number) === n));
    for (const n of unfound.slice(0, MAX_LINES)) {
      const re = looseItemRegex(n);
      if (!re) continue;
      const { data } = await service.from('netsuite_parts').select(PART_FIELDS).eq('is_active', true).filter('item_number', 'imatch', re).limit(5);
      for (const p of (data as NetsuiteCatalogPart[]) || []) if (!catalog.some(c => c.id === p.id)) catalog.push(p);
    }
    // An active row wins over an inactive one with the same number.
    catalog.sort((a, b) => Number(b.is_active !== false) - Number(a.is_active !== false));

    const lines: DraftLine[] = requests.map(r => matchNetsuiteLine(r, catalog));

    let customer: { id: string; name: string; netsuiteId: string } | null = null;
    if (customerNetsuiteId) {
      const { data } = await service
        .from('customers')
        .select('id, company_name, entity_id, netsuite_id')
        .eq('netsuite_id', customerNetsuiteId)
        .limit(2);
      // Two FleetSuite rows on one NetSuite id: leave the pick to the rep.
      if (data && data.length === 1) {
        customer = { id: data[0].id, name: data[0].company_name || data[0].entity_id || '', netsuiteId: data[0].netsuite_id };
      }
    }

    return NextResponse.json({
      vehicleCount: null,
      lines,
      summary: summarize(lines),
      truncated: all.length > requests.length ? { found: all.length, shown: requests.length } : null,
      skipped,
      source: { type, netsuiteId, number: doc.number, typeLabel: doc.typeLabel, date: doc.date },
      customer,
    });
  } catch (e: any) {
    console.error('draft-from-netsuite failed:', e);
    return NextResponse.json({ error: e?.message || 'Could not copy that NetSuite record' }, { status: 500 });
  }
}
