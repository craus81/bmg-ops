import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { transactionUrl } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

/** NetSuite PO status letters per filter. Received = Pending Bill / Fully
 *  Billed; Closed = Rejected / Closed; everything else (and a mirror row
 *  with no status yet) is still open. */
const RECEIVED = ['F', 'G'];
const CLOSED = ['C', 'H'];

const FLEETSUITE_MEMO = 'FleetSuite purchase requests';

function poUrl(netsuiteId: string | null): string | null {
  if (!netsuiteId) return null;
  try { return transactionUrl('purchord', netsuiteId); } catch { return null; }
}

/**
 * GET /api/purchase-requests/vendor-pos — the Purchasing page's Vendor POs
 * tab: every vendor PO in the NetSuite mirror, newest first, with its lines
 * and the requests each line holds (which is what the per-line Undo acts
 * on). ?status=open|received|closed|all, ?fleetsuite=1 for only POs made
 * here, ?q= for a PO number, vendor or part number.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const service = createServiceClient();
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') || 'open';
  const onlyFleetsuite = searchParams.get('fleetsuite') === '1';
  const q = (searchParams.get('q') || '').trim().replace(/[%,()]/g, ' ').trim().slice(0, 60);

  let query = service
    .from('netsuite_vendor_pos')
    .select('id, netsuite_id, tranid, vendor_name, trandate, status, status_label, memo, total, eta_date, tracking_number, carrier')
    .order('trandate', { ascending: false, nullsFirst: false })
    .order('id')
    .limit(100);
  if (status === 'received') query = query.in('status', RECEIVED);
  else if (status === 'closed') query = query.in('status', CLOSED);
  else if (status !== 'all') query = query.or(`status.is.null,status.not.in.(${[...RECEIVED, ...CLOSED].join(',')})`);

  if (q) {
    // One .or() per query (the status filter above uses it), so the search
    // resolves to PO ids first: number or vendor, or a part on the PO.
    const [{ data: headHits }, { data: lineHits }] = await Promise.all([
      service.from('netsuite_vendor_pos').select('id')
        .or(`tranid.ilike.%${q}%,vendor_name.ilike.%${q}%`)
        .order('trandate', { ascending: false, nullsFirst: false }).limit(300),
      service.from('netsuite_vendor_po_lines').select('po_id')
        .ilike('item_number', `%${q}%`).order('id', { ascending: false }).limit(300),
    ]);
    const hitIds = [...new Set([
      ...((headHits || []) as any[]).map(h => h.id as string),
      ...((lineHits || []) as any[]).map(h => h.po_id as string),
    ])].slice(0, 300);
    if (hitIds.length === 0) return NextResponse.json({ success: true, pos: [] });
    query = query.in('id', hitIds);
  }

  const { data: poRows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const pos = (poRows || []) as any[];
  const ids = pos.map(p => p.id as string);
  if (ids.length === 0) return NextResponse.json({ success: true, pos: [] });

  const [lines, requests] = await Promise.all([
    fetchAllRows<any>((from, to) => service
      .from('netsuite_vendor_po_lines')
      .select('id, po_id, line_id, item_number, item_netsuite_id, description, quantity, quantity_received, rate')
      .in('po_id', ids)
      .order('po_id').order('line_id').order('id')
      .range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('purchase_requests')
      .select('id, ordered_po_id, item_number, netsuite_item_id, quantity, status, ordered_match, upfit_projects(id, project_name, netsuite_so_number), estimates(id, estimate_number, customer_name)')
      .in('ordered_po_id', ids)
      .eq('status', 'ordered')
      .order('id')
      .range(from, to)),
  ]);

  const out = pos.map(po => {
    const myRequests = ((requests.data || []) as any[]).filter(r => r.ordered_po_id === po.id);
    const madeHere = myRequests.some(r => !r.ordered_match) || String(po.memo || '').startsWith(FLEETSUITE_MEMO);
    if (onlyFleetsuite && !madeHere) return null;
    return {
      ...po,
      made_in_fleetsuite: madeHere,
      url: poUrl(po.netsuite_id),
      lines: ((lines.data || []) as any[]).filter(l => l.po_id === po.id).map(l => ({
        ...l,
        // A request rides a line by its NetSuite item id (create-po makes one
        // line per item), falling back to the part number.
        requests: myRequests.filter(r => (l.item_netsuite_id && r.netsuite_item_id)
          ? r.netsuite_item_id === l.item_netsuite_id
          : r.item_number === l.item_number),
      })),
    };
  }).filter(Boolean);

  return NextResponse.json({ success: true, pos: out });
}
