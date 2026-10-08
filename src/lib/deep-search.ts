/**
 * The universal search's text groups: words people TYPED into a record
 * (memos, notes) rather than its number or name. Owner request 2026-10-08:
 * "search for memos on QuickBooks invoices, etc." — agreed scope:
 *
 *   qb_history       QuickBooks sales documents from before the cutover:
 *                    number, customer, PO, both memos, line text. The same
 *                    rules as a customer's Transactions (src/lib/ledger/history.ts).
 *   ns_transactions  NetSuite invoices and sales orders (memo, reference no.)
 *                    and vendor POs (memo, vendor), from the local mirrors —
 *                    no NetSuite call.
 *   notes            Notes on vehicles, POs, graphics jobs, upfit projects
 *                    and estimates.
 *   bills            QuickBooks bills, expenses and checks: vendor, number,
 *                    memo, line text. Full results page only.
 *
 * Who sees what (owner decision 2026-10-08): customer billing — QuickBooks
 * history, NetSuite invoices and sales orders, estimate notes — stays behind
 * the money wall; bills stay with the ledger readers, the same tier as every
 * other bill surface. Every other group is gated by the feature that opens
 * the page its result links to, so no result is a dead click.
 *
 * Speed: these run only at DEEP_MIN_QUERY characters and up, every column
 * searched carries a trigram index (migration 354), and the top bar asks
 * for a handful per group; "See all results" asks for more.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FeatureKey } from '@/lib/features';
import { deepLinks } from '@/lib/deep-links';
import { historySearchTerms, listHistory } from '@/lib/ledger/history';

/** Shortest query the text groups run on (trigram indexes need three). */
export const DEEP_MIN_QUERY = 3;

export interface DeepSearchAccess {
  /** canSeeMoney: QuickBooks history, NetSuite invoices/SOs, estimate notes. */
  money: boolean;
  /** isLedgerReader: bills. */
  ledgerReader: boolean;
  features: ReadonlySet<FeatureKey>;
}

export interface DeepSearchOptions {
  /** Rows per group. */
  limit: number;
  /** Bills only render on the full results page. */
  includeBills: boolean;
}

export interface DeepSearchResult {
  results: Record<string, any[]>;
  /** True match counts, where one is cheap to know. */
  totals: Record<string, number>;
  /** Groups that have more than they returned but no exact count. */
  more: Record<string, boolean>;
}

/**
 * The query as one phrase PostgREST can carry, or null when it's too short.
 * Same cleaning as the history search: characters that mean something inside
 * `.or()` / `ilike` become spaces rather than being escaped half-right.
 */
export function deepSearchPhrase(q: string | null | undefined): string | null {
  const phrase = historySearchTerms(q).join(' ');
  return phrase.length >= DEEP_MIN_QUERY ? phrase : null;
}

/**
 * A short excerpt of `text` around the first case-insensitive hit of
 * `phrase`, so a result says why it is here. Falls back to the start of the
 * text when the phrase isn't in it (a line match, or a different column).
 */
export function excerpt(text: string | null | undefined, phrase: string, width = 110): string | null {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= width) return t;
  const at = t.toLowerCase().indexOf(phrase.toLowerCase());
  if (at < 0) return t.slice(0, width - 1).trimEnd() + '…';
  const start = Math.max(0, Math.min(at - Math.floor((width - phrase.length) / 2), t.length - width));
  const end = Math.min(t.length, start + width);
  return (start > 0 ? '…' : '') + t.slice(start, end).trim() + (end < t.length ? '…' : '');
}

/** The first of `fields` that contains the phrase, for the excerpt. */
function firstHit(phrase: string, ...fields: (string | null | undefined)[]): string | null {
  const p = phrase.toLowerCase();
  return fields.find(f => !!f && f.toLowerCase().includes(p)) || null;
}

const contains = (phrase: string) => `%${phrase}%`;
/** An `.or()` of ilike on several columns, values quoted so spaces survive. */
const orIlike = (cols: string[], phrase: string) => cols.map(c => `${c}.ilike."*${phrase}*"`).join(',');

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

function byDateDesc(a: { date: string | null }, b: { date: string | null }) {
  return String(b.date || '').localeCompare(String(a.date || ''));
}

async function qbHistory(service: SupabaseClient, q: string, phrase: string, limit: number) {
  const { rows, hasMore } = await listHistory(service, { q, limit });
  const items = rows.map(r => ({
    id: r.id,
    type_label: r.typeLabel,
    number: r.number,
    date: r.date,
    customer: r.customerName,
    po: r.po,
    snippet: excerpt(firstHit(phrase, r.memo, r.privateNote) || r.matchedLine || r.memo || r.privateNote, phrase),
    pdf_document_id: r.pdfDocumentId,
  }));
  return { items, more: hasMore };
}

async function nsTransactions(service: SupabaseClient, phrase: string, limit: number, access: DeepSearchAccess) {
  const wantVendorPos = access.money || access.features.has('parts_ordering');
  const [invoices, salesOrders, vendorPos] = await Promise.all([
    access.money
      ? service.from('ledger_invoices')
          .select('id, doc_number, external_ref, doc_date, party_name, po_number, memo', { count: 'exact' })
          .eq('source', 'netsuite').eq('doc_type', 'invoice').eq('voided', false).is('deleted_at', null)
          .or(orIlike(['memo', 'po_number'], phrase))
          .order('doc_date', { ascending: false }).limit(limit)
      : null,
    access.money
      ? service.from('netsuite_sales_orders')
          .select('id, tranid, trandate, customer_name, customer_netsuite_id, memo, otherrefnum, vin, estimate_id', { count: 'exact' })
          .or(orIlike(['memo', 'otherrefnum'], phrase))
          .order('trandate', { ascending: false, nullsFirst: false }).limit(limit)
      : null,
    wantVendorPos
      ? service.from('netsuite_vendor_pos')
          .select('id, tranid, trandate, vendor_name, memo', { count: 'exact' })
          .or(orIlike(['memo', 'vendor_name'], phrase))
          .order('trandate', { ascending: false, nullsFirst: false }).limit(limit)
      : null,
  ]);

  const items: any[] = [];
  let total = 0;
  for (const r of (invoices?.data || []) as any[]) {
    const number = r.doc_number || r.external_ref;
    items.push({
      id: `nsinv-${r.id}`, kind: 'invoice', kind_label: 'Invoice', number,
      party: r.party_name, date: r.doc_date,
      snippet: excerpt(firstHit(phrase, r.memo, r.po_number) || r.memo, phrase),
      url: deepLinks.invoicesSent(number),
    });
  }
  total += invoices?.count ?? (invoices?.data || []).length;
  for (const r of (salesOrders?.data || []) as any[]) {
    // An SO has no page of its own: its estimate, else its vehicle, else
    // the customer — each a real record.
    const url = r.estimate_id ? deepLinks.estimate(r.estimate_id)
      : r.vin ? deepLinks.vehicleRecord(r.vin)
      : r.customer_netsuite_id ? deepLinks.customerByNetsuiteId(r.customer_netsuite_id)
      : null;
    if (!url) continue;
    items.push({
      id: `nsso-${r.id}`, kind: 'sales_order', kind_label: 'Sales Order', number: r.tranid,
      party: r.customer_name, date: r.trandate,
      snippet: excerpt(firstHit(phrase, r.memo, r.otherrefnum) || r.memo, phrase),
      url,
    });
  }
  total += salesOrders?.count ?? (salesOrders?.data || []).length;
  for (const r of (vendorPos?.data || []) as any[]) {
    items.push({
      id: `nspo-${r.id}`, kind: 'vendor_po', kind_label: 'Vendor PO', number: r.tranid,
      party: r.vendor_name, date: r.trandate,
      snippet: excerpt(r.memo, phrase),
      url: deepLinks.receiving(r.id),
    });
  }
  total += vendorPos?.count ?? (vendorPos?.data || []).length;

  items.sort(byDateDesc);
  return { items: items.slice(0, limit), total: Math.max(total, Math.min(items.length, limit)) };
}

async function notes(service: SupabaseClient, phrase: string, limit: number, access: DeepSearchAccess) {
  const f = access.features;
  const like = contains(phrase);
  const vehicles = f.has('in_shop') || f.has('fleet_checkin');
  const pos = f.has('purchase_orders');
  const graphics = f.has('graphics');
  const upfit = f.has('upfit_projects');
  const estimates = access.money && f.has('estimates');

  const [vNotes, pNotes, gNotes, gJobs, uNotes, eNotes] = await Promise.all([
    vehicles
      ? service.from('vehicle_notes')
          .select('id, vehicle_id, note, created_by_name, created_at, vehicle:fleet_checkins(vehicle_year, vehicle_make, vehicle_model, vin, customer_name)', { count: 'exact' })
          .ilike('note', like).order('created_at', { ascending: false }).limit(limit)
      : null,
    pos
      ? service.from('po_notes')
          .select('id, po_id, body, created_at, po:purchase_orders(po_number, customer)', { count: 'exact' })
          .ilike('body', like).order('created_at', { ascending: false }).limit(limit)
      : null,
    graphics
      ? service.from('graphics_status_history')
          .select('id, job_id, note, created_at, job:graphics_jobs(job_number, title, customer)', { count: 'exact' })
          .ilike('note', like).order('created_at', { ascending: false }).limit(limit)
      : null,
    graphics
      ? service.from('graphics_jobs')
          .select('id, job_number, title, customer, notes, created_at', { count: 'exact' })
          .ilike('notes', like).order('created_at', { ascending: false }).limit(limit)
      : null,
    upfit
      ? service.from('upfit_project_notes')
          .select('id, project_id, content, created_at, project:upfit_projects(project_name, customer_name)', { count: 'exact' })
          .eq('note_type', 'note')
          .ilike('content', like).order('created_at', { ascending: false }).limit(limit)
      : null,
    estimates
      ? service.from('estimates')
          .select('id, estimate_number, netsuite_estimate_number, title, notes, created_at', { count: 'exact' })
          .ilike('notes', like).order('created_at', { ascending: false }).limit(limit)
      : null,
  ]);

  const items: any[] = [];
  for (const r of (vNotes?.data || []) as any[]) {
    const v = one(r.vehicle) as any;
    const label = v ? [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || v.vin : 'Vehicle';
    items.push({
      id: `vn-${r.id}`, kind: 'vehicle', kind_label: 'Vehicle note',
      label, sub: v?.customer_name || null, by: r.created_by_name || null,
      snippet: excerpt(r.note, phrase), date: r.created_at,
      url: deepLinks.vehicle(r.vehicle_id, r.id),
    });
  }
  for (const r of (pNotes?.data || []) as any[]) {
    const p = one(r.po) as any;
    items.push({
      id: `pn-${r.id}`, kind: 'po', kind_label: 'PO note',
      label: p?.po_number ? `PO #${p.po_number}` : 'Purchase order', sub: p?.customer || null,
      snippet: excerpt(r.body, phrase), date: r.created_at,
      url: deepLinks.po(r.po_id),
    });
  }
  for (const r of (gNotes?.data || []) as any[]) {
    const j = one(r.job) as any;
    items.push({
      id: `gn-${r.id}`, kind: 'graphics', kind_label: 'Graphics note',
      label: j ? `${j.job_number ? `#${j.job_number} ` : ''}${j.title || ''}`.trim() || 'Graphics job' : 'Graphics job',
      sub: j?.customer || null,
      snippet: excerpt(r.note, phrase), date: r.created_at,
      url: deepLinks.graphicsJob(r.job_id),
    });
  }
  for (const r of (gJobs?.data || []) as any[]) {
    items.push({
      id: `gj-${r.id}`, kind: 'graphics', kind_label: 'Graphics job notes',
      label: `${r.job_number ? `#${r.job_number} ` : ''}${r.title || ''}`.trim() || 'Graphics job',
      sub: r.customer || null,
      snippet: excerpt(r.notes, phrase), date: r.created_at,
      url: deepLinks.graphicsJob(r.id),
    });
  }
  for (const r of (uNotes?.data || []) as any[]) {
    const p = one(r.project) as any;
    items.push({
      id: `un-${r.id}`, kind: 'upfit', kind_label: 'Upfit note',
      label: p?.project_name || 'Upfit project', sub: p?.customer_name || null,
      snippet: excerpt(r.content, phrase), date: r.created_at,
      url: deepLinks.upfitProject(r.project_id, { noteId: r.id }),
    });
  }
  for (const r of (eNotes?.data || []) as any[]) {
    items.push({
      id: `en-${r.id}`, kind: 'estimate', kind_label: 'Estimate notes',
      label: r.estimate_number ? `Estimate ${r.estimate_number}` : (r.netsuite_estimate_number ? `Estimate ${r.netsuite_estimate_number}` : 'Estimate'),
      sub: r.title || null,
      snippet: excerpt(r.notes, phrase), date: r.created_at,
      url: deepLinks.estimate(r.id, { flashNotes: true }),
    });
  }

  const total = [vNotes, pNotes, gNotes, gJobs, uNotes, eNotes]
    .reduce((s, res) => s + (res ? (res.count ?? (res.data || []).length) : 0), 0);
  items.sort(byDateDesc);
  return { items: items.slice(0, limit), total: Math.max(total, Math.min(items.length, limit)) };
}

const BILL_TYPE_LABEL: Record<string, string> = {
  bill: 'Bill', vendor_credit: 'Vendor Credit', expense: 'Expense', check: 'Check', card_charge: 'Card Charge',
};

async function bills(service: SupabaseClient, phrase: string, limit: number) {
  const cols = 'id, doc_type, doc_number, external_ref, doc_date, vendor_name, total, memo, private_note';
  const base = () => service.from('ledger_bills').select(cols)
    .eq('source', 'quickbooks').eq('voided', false).is('deleted_at', null);

  // Header hits and line hits, merged here: PostgREST can't .or() across tables.
  const [byHeader, lineHits] = await Promise.all([
    base().or(orIlike(['vendor_name', 'doc_number', 'memo', 'private_note'], phrase))
      .order('doc_date', { ascending: false }).limit(limit + 1),
    service.from('ledger_bill_lines')
      .select('document_id, description, doc:ledger_bills!inner(source, voided, deleted_at)')
      .eq('doc.source', 'quickbooks').eq('doc.voided', false).is('doc.deleted_at', null)
      .ilike('description', contains(phrase))
      .limit(200),
  ]);
  if (byHeader.error) throw new Error(`Bill search failed: ${byHeader.error.message}`);
  if (lineHits.error) throw new Error(`Bill line search failed: ${lineHits.error.message}`);

  const matchedLine = new Map<string, string>();
  for (const l of (lineHits.data || []) as any[]) {
    if (l.document_id && !matchedLine.has(l.document_id)) matchedLine.set(l.document_id, l.description || '');
  }
  const headerRows = (byHeader.data || []) as any[];
  const have = new Set(headerRows.map(r => r.id));
  const extraIds = [...matchedLine.keys()].filter(id => !have.has(id)).slice(0, 150);
  let lineRows: any[] = [];
  if (extraIds.length) {
    const { data, error } = await base().in('id', extraIds)
      .order('doc_date', { ascending: false }).limit(limit + 1);
    if (error) throw new Error(`Bill search failed: ${error.message}`);
    lineRows = data || [];
  }
  const all = [...headerRows, ...lineRows].sort((a, b) => String(b.doc_date).localeCompare(String(a.doc_date)));
  const page = all.slice(0, limit);

  const pdfs = new Map<string, string>();
  if (page.length) {
    const { data } = await service.from('ledger_documents')
      .select('id, entity_row_id')
      .eq('entity_table', 'ledger_bills').eq('kind', 'pdf').eq('status', 'stored')
      .in('entity_row_id', page.map(r => r.id));
    for (const d of (data || []) as any[]) if (!pdfs.has(d.entity_row_id)) pdfs.set(d.entity_row_id, d.id);
  }

  const items = page.map(r => ({
    id: r.id,
    type_label: BILL_TYPE_LABEL[r.doc_type] || 'Bill',
    number: r.doc_number || null,
    vendor: r.vendor_name || 'Unknown vendor',
    date: r.doc_date,
    total: Number(r.total) || 0,
    snippet: excerpt(firstHit(phrase, r.memo, r.private_note) || matchedLine.get(r.id) || r.memo || r.private_note, phrase),
    pdf_document_id: pdfs.get(r.id) || null,
  }));
  return { items, more: all.length > limit };
}

/** Run every text group this viewer may see, in parallel. */
export async function deepSearch(
  service: SupabaseClient,
  q: string,
  access: DeepSearchAccess,
  opts: DeepSearchOptions,
): Promise<DeepSearchResult> {
  const out: DeepSearchResult = { results: {}, totals: {}, more: {} };
  const phrase = deepSearchPhrase(q);
  if (!phrase) return out;
  const limit = Math.max(1, Math.min(50, Math.floor(opts.limit)));

  // One group failing (a missing mirror table, a timeout) must not blank the
  // whole search: log it and leave that group out.
  const safe = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (err) { console.error(`search: ${label} failed:`, err); return null; }
  };

  const [qb, ns, nt, bl] = await Promise.all([
    access.money ? safe('QuickBooks history', () => qbHistory(service, q, phrase, limit)) : null,
    safe('NetSuite transactions', () => nsTransactions(service, phrase, limit, access)),
    safe('notes', () => notes(service, phrase, limit, access)),
    access.ledgerReader && opts.includeBills ? safe('bills', () => bills(service, phrase, limit)) : null,
  ]);

  if (qb?.items.length) {
    out.results.qb_history = qb.items;
    out.totals.qb_history = qb.items.length;
    if (qb.more) out.more.qb_history = true;
  }
  if (ns?.items.length) {
    out.results.ns_transactions = ns.items;
    out.totals.ns_transactions = ns.total;
  }
  if (nt?.items.length) {
    out.results.notes = nt.items;
    out.totals.notes = nt.total;
  }
  if (bl?.items.length) {
    out.results.bills = bl.items;
    out.totals.bills = bl.items.length;
    if (bl.more) out.more.bills = true;
  }
  return out;
}
