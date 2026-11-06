import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { profileCanSeeMoney, requireAuth } from '@/lib/api-auth';
import { salesOrderMakerError } from '@/lib/new-sales-order-auth';
import { loadNetsuiteCopyDoc } from '@/lib/netsuite-copy-source';
import { NETSUITE_COPY_TYPES, nsItemNumber, type NetsuiteCopyType } from '@/lib/netsuite-estimate-copy';
import { loadTypedItems } from '@/lib/typed-line-items';
import { getDefaultLaborRate } from '@/lib/labor-rate';
import { copyLinesForSalesOrder } from '@/lib/so-copy';
import type { NewInvoiceItem } from '@/lib/new-invoice';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createServiceClient();

interface Source { type: NetsuiteCopyType; netsuiteId: string; number: string; customer: string | null; date: string | null; memo: string | null }

/** Up to 8 of each kind, newest first, by number or customer name; or the customer's own when only a customer is given. */
async function searchSources(q: string, customerNetsuiteId: string | null): Promise<Source[]> {
  const term = q.replace(/[%,()]/g, ' ').trim().slice(0, 60);
  if (term.length < 2 && !customerNetsuiteId) return [];
  const like = `%${term}%`;
  const so = service.from('netsuite_sales_orders').select('netsuite_id, tranid, customer_name, trandate, memo');
  const est = service.from('netsuite_estimates').select('netsuite_id, tranid, customer_name, trandate, memo');
  const inv = service.from('ledger_invoices').select('external_ref, doc_number, party_name, doc_date, memo')
    .eq('source', 'netsuite').eq('doc_type', 'invoice').is('deleted_at', null);
  const [sos, ests, invs] = await Promise.all([
    (term.length >= 2 ? so.or(`tranid.ilike.${like},customer_name.ilike.${like}`) : so.eq('customer_netsuite_id', customerNetsuiteId!))
      .order('trandate', { ascending: false }).limit(8),
    (term.length >= 2 ? est.or(`tranid.ilike.${like},customer_name.ilike.${like}`) : est.eq('customer_netsuite_id', customerNetsuiteId!))
      .order('trandate', { ascending: false }).limit(8),
    (term.length >= 2 ? inv.or(`doc_number.ilike.${like},party_name.ilike.${like}`) : inv.eq('customer_netsuite_id', customerNetsuiteId!))
      .order('doc_date', { ascending: false }).limit(8),
  ]);
  return [
    ...(sos.data || []).map((r: any) => ({ type: 'salesOrder' as const, netsuiteId: String(r.netsuite_id), number: r.tranid, customer: r.customer_name, date: r.trandate, memo: r.memo })),
    ...(invs.data || []).map((r: any) => ({ type: 'invoice' as const, netsuiteId: String(r.external_ref), number: r.doc_number, customer: r.party_name, date: r.doc_date, memo: r.memo })),
    ...(ests.data || []).map((r: any) => ({ type: 'estimate' as const, netsuiteId: String(r.netsuite_id), number: r.tranid, customer: r.customer_name, date: r.trandate, memo: r.memo })),
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

/**
 * Copy from… on a new sales order (src/lib/so-copy.ts).
 *   GET ?q=…[&customer=<NetSuite id>]  old sales orders, invoices and estimates to copy.
 *   GET ?type=salesOrder|invoice|estimate&id=<NetSuite id>  that document's lines at today's prices.
 * Reads FleetSuite's own copies of NetSuite only; writes nothing.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  const notMaker = await salesOrderMakerError(auth);
  if (notMaker) return notMaker;
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) {
    return NextResponse.json({ error: 'Forbidden: this account cannot see prices' }, { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  const type = sp.get('type') as NetsuiteCopyType | null;
  const id = sp.get('id') || '';

  if (!type) {
    const customer = sp.get('customer');
    return NextResponse.json({ sources: await searchSources(sp.get('q') || '', customer && /^\d+$/.test(customer) ? customer : null) });
  }
  if (!NETSUITE_COPY_TYPES.includes(type) || !/^\d+$/.test(id)) return NextResponse.json({ error: 'Bad copy source' }, { status: 400 });

  const loaded = await loadNetsuiteCopyDoc(service, type, id);
  if (!loaded) {
    return NextResponse.json({ error: "FleetSuite doesn't have a copy of that document yet. New ones copy over every two hours." }, { status: 404 });
  }
  const { doc } = loaded;

  // Today's catalog rows: by NetSuite id, then by item number for lines without one.
  const ids = [...new Set(doc.lines.map(l => l.itemNetsuiteId).filter((v): v is string => !!v))];
  const { byId, error } = await loadTypedItems(service, ids);
  if (error) return NextResponse.json({ error }, { status: 500 });
  const numbers = [...new Set(doc.lines.map(l => nsItemNumber(l.itemNumber)).filter((v): v is string => !!v))];
  const byNumber = new Map<string, NewInvoiceItem>();
  for (const item of byId.values()) byNumber.set(nsItemNumber(item.itemNumber) || '', item);
  const unseen = numbers.filter(n => !byNumber.has(n));
  if (unseen.length > 0) {
    const { data } = await service.from('netsuite_parts').select('netsuite_id').eq('is_active', true).in('item_number', unseen);
    const more = await loadTypedItems(service, ((data || []) as { netsuite_id: string | number | null }[]).filter(r => r.netsuite_id != null).map(r => String(r.netsuite_id)));
    for (const item of more.byId.values()) if (!byNumber.has(nsItemNumber(item.itemNumber) || '')) byNumber.set(nsItemNumber(item.itemNumber) || '', item);
  }

  const copy = copyLinesForSalesOrder(doc, { byId, byNumber }, await getDefaultLaborRate(service));
  return NextResponse.json({ source: { type, netsuiteId: id, number: doc.number, typeLabel: doc.typeLabel, date: doc.date }, ...copy });
}
