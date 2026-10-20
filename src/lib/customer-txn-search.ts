import type { SupabaseClient } from '@supabase/supabase-js';
import { looseMatcher, looseSearchRegex } from '@/lib/loose-search';

/**
 * The customer page's Transactions search, beyond the number (owner ask
 * 2026-10-19: "can we make this search all lines of a transaction?"; Craig
 * chose lines plus memo, PO and VIN).
 *
 * The page lists NetSuite's documents live and a page at a time, so its own
 * filter only ever saw the numbers it had loaded. This looks through the
 * copies FleetSuite already keeps, for ALL of the customer's history:
 *
 *   NetSuite invoices + credit memos  ledger_invoices / ledger_invoice_lines (netsuite-mirror)
 *   NetSuite sales orders             netsuite_sales_orders / _lines
 *   NetSuite estimates                netsuite_estimates / _lines
 *   FleetSuite estimates              estimates / estimate_line_items
 *
 * QuickBooks history already searches its own lines (/api/ledger/history?q=).
 * Payments carry no item lines; the page matches their memo itself.
 *
 * Descriptions, memos and titles match loosely (src/lib/loose-search.ts).
 * Part numbers, PO / reference numbers and VINs stay a plain "contains"
 * match, like every other exact lookup in the app.
 */

export type TxnSearchKind = 'invoice' | 'credit' | 'salesOrder' | 'estimate';

export interface TxnSearchHit {
  source: 'netsuite' | 'fleetsuite';
  kind: TxnSearchKind;
  /** NetSuite internal id, or the FleetSuite estimate's uuid. */
  id: string;
  number: string;
  date: string | null;
  dueDate: string | null;
  total: number;
  status: string;
  /** Invoices only: paid in full (null when unknown). */
  paid: boolean | null;
  /** Why it matched, for the line under the row ("Line: …", "PO: …"). */
  why: string;
  /** FleetSuite estimates only: the NetSuite estimate it was pushed into,
   *  which the page shows in its place. */
  linkedNsId?: string | null;
}

export const TXN_SEARCH_MIN = 2;
/** Per query; a customer's search rarely needs more than a screenful. */
const CAP = 200;

/** The typed text as a safe "contains" value for exact columns: letters,
 *  digits and dashes only, so it can ride a PostgREST filter unquoted. */
export function exactTerm(q: string): string {
  return q.replace(/[^A-Za-z0-9-]/g, '');
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function lineWhy(item: string | null, desc: string | null): string {
  const parts = [item, desc].map(s => (s || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return `Line: ${clip(parts.join(' · '))}`;
}

/** Which header field matched, in the order a person would recognise it. */
export function headerWhy(q: string, h: { memo?: string | null; po?: string | null; vin?: string | null; title?: string | null; notes?: string | null }): string | null {
  const term = exactTerm(q).toLowerCase();
  const has = (v: string | null | undefined) => !!term && !!v && v.toLowerCase().replace(/[^a-z0-9-]/g, '').includes(term);
  if (has(h.vin)) return `VIN: ${h.vin}`;
  if (has(h.po)) return `PO: ${h.po}`;
  const loose = looseMatcher(q);
  if (h.title && loose(h.title)) return `Title: ${clip(h.title)}`;
  if (h.memo && loose(h.memo)) return `Memo: ${clip(h.memo)}`;
  if (h.notes && loose(h.notes)) return `Notes: ${clip(h.notes)}`;
  return null;
}

/** One header's or line's columns, filtered loosely and exactly. */
function orOf(loose: string[], exact: string[], q: string): string | null {
  const re = looseSearchRegex(q);
  const term = exactTerm(q);
  const parts = [
    ...(re ? loose.map(c => `${c}.imatch."${re}"`) : []),
    ...(term ? exact.map(c => `${c}.ilike.*${term}*`) : []),
  ];
  return parts.length ? parts.join(',') : null;
}

type Row = Record<string, any>;

function check(res: { data: unknown; error: { message: string } | null }, what: string): Row[] {
  if (res.error) throw new Error(`Could not search ${what}: ${res.error.message}`);
  return (res.data || []) as Row[];
}

/**
 * Every transaction of this NetSuite customer whose lines, memo, PO /
 * reference number or VIN match `q`, newest first. A transaction appears
 * once, with the first reason found (lines before header fields).
 */
export async function searchCustomerTransactions(
  service: SupabaseClient,
  customerNsId: string,
  q: string,
): Promise<TxnSearchHit[]> {
  const lineOr = orOf(['description'], ['item_number'], q);
  const hits = new Map<string, TxnSearchHit>();
  const add = (h: TxnSearchHit) => {
    const k = `${h.source}-${h.kind}-${h.id}`;
    if (!hits.has(k)) hits.set(k, h);
  };

  // ── NetSuite invoices and credit memos (the ledger mirror) ──────────────
  const INV_COLS = 'id, external_ref, doc_type, doc_number, doc_date, due_date, total, status, status_label, paid, po_number, memo';
  const invHit = (d: Row, why: string): TxnSearchHit => ({
    source: 'netsuite',
    kind: d.doc_type === 'credit_memo' ? 'credit' : 'invoice',
    id: String(d.external_ref),
    number: d.doc_number || String(d.external_ref),
    date: d.doc_date || null,
    dueDate: d.due_date || null,
    total: Number(d.total) || 0,
    status: d.status_label || d.status || '',
    paid: d.paid ?? null,
    why,
  });
  const invBase = (cols: string) => service.from('ledger_invoices').select(cols)
    .eq('source', 'netsuite').eq('customer_netsuite_id', customerNsId)
    .in('doc_type', ['invoice', 'credit_memo']).is('deleted_at', null);

  // ── NetSuite sales orders / estimates (same header shape) ───────────────
  const NS_COLS = 'id, netsuite_id, tranid, trandate, status, status_label, total, memo, otherrefnum, vin';
  const nsHit = (kind: 'salesOrder' | 'estimate') => (d: Row, why: string): TxnSearchHit => ({
    source: 'netsuite', kind,
    id: String(d.netsuite_id),
    number: d.tranid || String(d.netsuite_id),
    date: d.trandate || null, dueDate: null,
    total: Number(d.total) || 0,
    status: d.status_label || d.status || '',
    paid: null,
    why,
  });

  // ── FleetSuite estimates ────────────────────────────────────────────────
  const FS_COLS = 'id, estimate_number, title, notes, po_number, status, grand_total, created_at, expiration_date, netsuite_estimate_id';
  const fsHit = (d: Row, why: string): TxnSearchHit => ({
    source: 'fleetsuite', kind: 'estimate',
    id: String(d.id),
    number: d.estimate_number || '',
    date: d.created_at ? String(d.created_at).slice(0, 10) : null,
    dueDate: d.expiration_date || null,
    total: Number(d.grand_total) || 0,
    status: d.status ? d.status.charAt(0).toUpperCase() + d.status.slice(1) : '',
    paid: null,
    why,
    linkedNsId: d.netsuite_estimate_id ? String(d.netsuite_estimate_id) : null,
  });

  const headerOr = (memoCols: string[], exactCols: string[]) => orOf(memoCols, exactCols, q);
  const invHeaderOr = headerOr(['memo'], ['po_number']);
  const nsHeaderOr = headerOr(['memo'], ['otherrefnum', 'vin']);
  const fsHeaderOr = headerOr(['title', 'notes'], ['po_number']);

  const [invLines, invHeads, soLines, soHeads, estLines, estHeads, fsLines, fsHeads] = await Promise.all([
    lineOr ? service.from('ledger_invoice_lines')
      .select(`item_number, item_name, description, doc:ledger_invoices!inner(${INV_COLS}, source, customer_netsuite_id, deleted_at)`)
      .eq('doc.source', 'netsuite').eq('doc.customer_netsuite_id', customerNsId).is('doc.deleted_at', null)
      .in('doc.doc_type', ['invoice', 'credit_memo'])
      .or(lineOr).limit(CAP) : null,
    invHeaderOr ? invBase(INV_COLS).or(invHeaderOr).limit(CAP) : null,
    lineOr ? service.from('netsuite_sales_order_lines')
      .select(`item_number, description, doc:netsuite_sales_orders!inner(${NS_COLS}, customer_netsuite_id)`)
      .eq('doc.customer_netsuite_id', customerNsId)
      .or(lineOr).limit(CAP) : null,
    nsHeaderOr ? service.from('netsuite_sales_orders').select(NS_COLS)
      .eq('customer_netsuite_id', customerNsId).or(nsHeaderOr).limit(CAP) : null,
    lineOr ? service.from('netsuite_estimate_lines')
      .select(`item_number, description, doc:netsuite_estimates!inner(${NS_COLS}, customer_netsuite_id)`)
      .eq('doc.customer_netsuite_id', customerNsId)
      .or(lineOr).limit(CAP) : null,
    nsHeaderOr ? service.from('netsuite_estimates').select(NS_COLS)
      .eq('customer_netsuite_id', customerNsId).or(nsHeaderOr).limit(CAP) : null,
    lineOr ? service.from('estimate_line_items')
      .select(`item_number, description, doc:estimates!inner(${FS_COLS}, customer_netsuite_id)`)
      .eq('doc.customer_netsuite_id', customerNsId)
      .or(lineOr).limit(CAP) : null,
    fsHeaderOr ? service.from('estimates').select(FS_COLS)
      .eq('customer_netsuite_id', customerNsId).or(fsHeaderOr).limit(CAP) : null,
  ]);

  const so = nsHit('salesOrder');
  const est = nsHit('estimate');
  if (invLines) for (const l of check(invLines, 'invoice lines')) add(invHit(l.doc, lineWhy(l.item_number || l.item_name, l.description)));
  if (soLines) for (const l of check(soLines, 'sales order lines')) add(so(l.doc, lineWhy(l.item_number, l.description)));
  if (estLines) for (const l of check(estLines, 'estimate lines')) add(est(l.doc, lineWhy(l.item_number, l.description)));
  if (fsLines) for (const l of check(fsLines, 'FleetSuite estimate lines')) add(fsHit(l.doc, lineWhy(l.item_number, l.description)));
  if (invHeads) for (const d of check(invHeads, 'invoices')) add(invHit(d, headerWhy(q, { memo: d.memo, po: d.po_number }) || 'Memo or PO'));
  if (soHeads) for (const d of check(soHeads, 'sales orders')) add(so(d, headerWhy(q, { memo: d.memo, po: d.otherrefnum, vin: d.vin }) || 'Memo, PO or VIN'));
  if (estHeads) for (const d of check(estHeads, 'estimates')) add(est(d, headerWhy(q, { memo: d.memo, po: d.otherrefnum, vin: d.vin }) || 'Memo, PO or VIN'));
  if (fsHeads) for (const d of check(fsHeads, 'FleetSuite estimates')) add(fsHit(d, headerWhy(q, { title: d.title, notes: d.notes, po: d.po_number }) || 'Title, notes or PO'));

  // A FleetSuite estimate pushed into NetSuite is one transaction: keep the
  // NetSuite copy's hit when both matched.
  for (const [k, h] of hits) {
    if (h.source === 'fleetsuite' && h.linkedNsId && hits.has(`netsuite-estimate-${h.linkedNsId}`)) hits.delete(k);
  }
  return [...hits.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
