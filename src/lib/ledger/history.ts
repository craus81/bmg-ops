import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * QuickBooks history, as FleetSuite's own lists show it.
 *
 * Owner decision (2026-09-24): imported QuickBooks transactions are not a
 * separate "old" area — they sit in the lists people already use (the
 * customer's Transactions, the Invoices search) with a QuickBooks source tag.
 * Their purposes are finding a build done years ago so it can be repeated,
 * and longer financial history. Four rules come with that, and this module
 * is where the first three are enforced for every reader:
 *
 *   1. Only rows dated BEFORE the cutover (`post_cutover = false`). From the
 *      cutover on, NetSuite is the record, and the QuickBooks copy of the
 *      overlap would show the same job twice.
 *   2. Never part of a balance. A QuickBooks balance is history, so nothing
 *      here feeds AR, aging, statements or money totals. Readers show it as a
 *      status word, never as an open amount.
 *   3. Read-only. No email, push, payment or NetSuite PDF. The row opens its
 *      stored QuickBooks PDF and attachments, and nothing else.
 *   4. A row shows under a customer only once its QuickBooks customer is
 *      matched (review queue on /admin/ledger). Search finds it regardless.
 *
 * Access: everyone behind the money wall (sales, admin, finance, executive)
 * sees these sales documents, so estimators can find past builds. Bills,
 * payments, journals and the financial reports stay with the ledger readers.
 */

export const HISTORY_SOURCE = 'quickbooks';

export type HistoryDocType = 'invoice' | 'credit_memo' | 'sales_receipt' | 'refund_receipt' | 'estimate';

export const HISTORY_DOC_TYPES: readonly HistoryDocType[] = ['invoice', 'credit_memo', 'sales_receipt', 'refund_receipt', 'estimate'];

export const HISTORY_TYPE_LABEL: Record<HistoryDocType, string> = {
  invoice: 'Invoice',
  credit_memo: 'Credit Memo',
  sales_receipt: 'Sales Receipt',
  refund_receipt: 'Refund',
  estimate: 'Estimate',
};

/** Longest page a caller may ask for. */
export const HISTORY_MAX_LIMIT = 200;
/** Cap on documents one line-text search can pull in before headers load. */
const LINE_MATCH_CAP = 1000;
/** Ids per `.in()` call: each UUID is 37 URL characters, and long URLs fail. */
const IN_CHUNK = 150;
/** Shortest search the server will run: two letters match half the catalog. */
export const HISTORY_MIN_QUERY = 3;

export interface HistoryRow {
  id: string;
  docType: HistoryDocType;
  typeLabel: string;
  number: string;
  date: string;
  dueDate: string | null;
  total: number;
  /** A status WORD for display ("Paid", "Unpaid in QuickBooks", "Accepted").
   *  Never an amount a reader could add into a balance. */
  status: string;
  paid: boolean;
  customerId: string | null;
  /** FleetSuite's name for the customer when linked, else QuickBooks' name. */
  customerName: string;
  po: string | null;
  memo: string | null;
  /** Stored QuickBooks PDF, when there is one. */
  pdfDocumentId: string | null;
  /** The line that matched a text search, so a result says why it's here. */
  matchedLine: string | null;
}

export interface HistoryLine {
  lineNo: number | null;
  kind: string;
  itemName: string | null;
  itemNumber: string | null;
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  serviceDate: string | null;
}

export interface HistoryDocument {
  id: string;
  kind: 'pdf' | 'attachment';
  fileName: string;
  contentType: string | null;
  sizeBytes: number | null;
}

export interface HistoryDetail extends HistoryRow {
  shipDate: string | null;
  subtotal: number | null;
  taxTotal: number | null;
  terms: string | null;
  customerMemo: string | null;
  className: string | null;
  billAddress: string | null;
  shipAddress: string | null;
  lines: HistoryLine[];
  documents: HistoryDocument[];
}

/**
 * Split a search into words PostgREST can carry safely. `.or()` and `.ilike`
 * values are spliced into the query string, where commas, parentheses,
 * quotes, backslashes and the `*`/`%`/`_` wildcards all mean something, so
 * those become spaces rather than being escaped half-right.
 */
export function historySearchTerms(q: string | null | undefined): string[] {
  const cleaned = String(q || '').replace(/[,()"'\\*%_:;]/g, ' ').trim().toLowerCase();
  if (!cleaned) return [];
  const words = cleaned.split(/\s+/).filter(Boolean);
  // Cap the word count: each one is another filter on a table scan.
  return [...new Set(words)].slice(0, 6);
}

/** The status word shown for a QuickBooks row (rule 2: never an amount). */
export function historyStatus(row: { doc_type: string; voided?: boolean | null; paid?: boolean | null; balance?: number | string | null; status?: string | null; status_label?: string | null }): { label: string; paid: boolean } {
  if (row.voided) return { label: 'Voided', paid: false };
  if (row.doc_type === 'estimate') {
    const s = String(row.status_label || row.status || '').trim();
    return { label: s || 'Estimate', paid: false };
  }
  if (row.doc_type === 'invoice') {
    const balance = row.balance === null || row.balance === undefined ? null : Number(row.balance);
    if (row.paid || balance === 0) return { label: 'Paid', paid: true };
    if (balance !== null && balance > 0) return { label: 'Unpaid in QuickBooks', paid: false };
    return { label: String(row.status_label || row.status || '').trim() || 'Invoice', paid: false };
  }
  // Credit memos, sales and refund receipts settle when they are written.
  return { label: 'Closed', paid: false };
}

/** The ledger reader tier (migration 314's is_ledger_reader): everything in
 *  the ledger. Other money roles see only history sales documents. */
export const LEDGER_READER_ROLES: readonly string[] = ['finance', 'executive', 'admin', 'super_admin'];

export function isLedgerReader(roles: readonly string[] | null | undefined): boolean {
  return !!roles && roles.some(r => LEDGER_READER_ROLES.includes(r));
}

/**
 * May a caller outside the reader tier open this stored document? Only when
 * it belongs to a sales document the history lists would show them.
 */
export async function isHistoryDocumentParent(service: SupabaseClient, entityTable: string | null, entityRowId: string | null): Promise<boolean> {
  if (entityTable !== 'ledger_invoices' || !entityRowId) return false;
  const { data, error } = await historyBase(service, 'id, doc_type').eq('id', entityRowId).maybeSingle();
  if (error) throw new Error(`Could not check the document's record: ${error.message}`);
  return !!data && isHistoryDocType((data as { doc_type?: string }).doc_type);
}

function isHistoryDocType(t: unknown): t is HistoryDocType {
  return typeof t === 'string' && (HISTORY_DOC_TYPES as readonly string[]).includes(t);
}

/** Addresses arrive as QuickBooks' PhysicalAddress JSON; show them as lines. */
export function formatHistoryAddress(addr: unknown): string | null {
  if (!addr || typeof addr !== 'object') return null;
  const a = addr as Record<string, unknown>;
  const lines = ['Line1', 'Line2', 'Line3', 'Line4', 'Line5']
    .map(k => (typeof a[k] === 'string' ? (a[k] as string).trim() : ''))
    .filter(Boolean);
  const cityLine = [a.City, a.CountrySubDivisionCode, a.PostalCode]
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .join(' ');
  if (cityLine) lines.push(cityLine);
  return lines.length ? lines.join('\n') : null;
}

const HEADER_COLS = 'id, doc_type, doc_number, external_ref, doc_date, due_date, total, balance, paid, voided, status, status_label, customer_id, party_name, po_number, memo, customer:customers(company_name)';

type HeaderRow = {
  id: string; doc_type: string; doc_number: string | null; external_ref: string; doc_date: string; due_date: string | null;
  total: number | string | null; balance: number | string | null; paid: boolean | null; voided: boolean | null;
  status: string | null; status_label: string | null; customer_id: string | null; party_name: string | null;
  po_number: string | null; memo: string | null; customer?: { company_name: string | null } | { company_name: string | null }[] | null;
};

function linkedName(row: HeaderRow): string | null {
  const c = Array.isArray(row.customer) ? row.customer[0] : row.customer;
  return c?.company_name || null;
}

function toRow(h: HeaderRow, pdfByDoc: Map<string, string>, matched: Map<string, string>): HistoryRow | null {
  if (!isHistoryDocType(h.doc_type)) return null;
  const st = historyStatus(h);
  return {
    id: h.id,
    docType: h.doc_type,
    typeLabel: HISTORY_TYPE_LABEL[h.doc_type],
    number: h.doc_number || h.external_ref,
    date: h.doc_date,
    dueDate: h.due_date,
    total: Number(h.total) || 0,
    status: st.label,
    paid: st.paid,
    customerId: h.customer_id,
    customerName: linkedName(h) || h.party_name || 'Unknown customer',
    po: h.po_number,
    memo: h.memo,
    pdfDocumentId: pdfByDoc.get(h.id) || null,
    matchedLine: matched.get(h.id) || null,
  };
}

/** The base filter every history read shares: rules 1 and 3 in one place. */
function historyBase(service: SupabaseClient, cols: string) {
  return service
    .from('ledger_invoices')
    .select(cols)
    .eq('source', HISTORY_SOURCE)
    .eq('post_cutover', false)
    .eq('voided', false)
    .is('deleted_at', null);
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function storedPdfs(service: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await service
      .from('ledger_documents')
      .select('id, entity_row_id')
      .eq('entity_table', 'ledger_invoices')
      .eq('kind', 'pdf')
      .eq('status', 'stored')
      .in('entity_row_id', part);
    if (error) throw new Error(`Could not read QuickBooks PDFs: ${error.message}`);
    for (const d of (data || []) as Array<{ id: string; entity_row_id: string }>) {
      if (!out.has(d.entity_row_id)) out.set(d.entity_row_id, d.id);
    }
  }
  return out;
}

/**
 * Documents whose LINES carry every search word, with the line that matched.
 * Two passes (description, then item name) because one line can hold all the
 * words in either column; each pass ANDs the words within its column. The
 * inner join scopes lines to the history set up front, so NetSuite's mirrored
 * lines and post-cutover rows can't use up the match cap.
 */
async function lineMatches(service: SupabaseClient, terms: string[], customerId: string | null): Promise<Map<string, string>> {
  const matched = new Map<string, string>();
  for (const col of ['description', 'item_name'] as const) {
    let q = service.from('ledger_invoice_lines')
      .select(`document_id, ${col}, doc:ledger_invoices!inner(source, post_cutover, voided, deleted_at, customer_id)`)
      .eq('doc.source', HISTORY_SOURCE)
      .eq('doc.post_cutover', false)
      .eq('doc.voided', false)
      .is('doc.deleted_at', null);
    if (customerId) q = q.eq('doc.customer_id', customerId);
    for (const t of terms) q = q.ilike(col, `%${t}%`);
    const { data, error } = await q.limit(LINE_MATCH_CAP);
    if (error) throw new Error(`Line search failed: ${error.message}`);
    for (const r of (data || []) as unknown as Array<Record<string, string | null>>) {
      const id = r.document_id;
      if (id && !matched.has(id)) matched.set(id, String(r[col] || ''));
    }
  }
  return matched;
}

export interface HistoryQuery {
  /** FleetSuite customers.id — rule 4: only rows linked to it. */
  customerId?: string | null;
  /** Free text: number, customer, PO, memo, or any line's words. */
  q?: string | null;
  types?: HistoryDocType[] | null;
  limit?: number;
  offset?: number;
}

/**
 * One page of QuickBooks history, newest first. With `q`, a document matches
 * when its header (number, customer, PO, memo) contains the whole phrase OR
 * one of its lines carries every word, which is how "transit shelving" finds
 * a build without the customer's name.
 */
export async function listHistory(service: SupabaseClient, query: HistoryQuery): Promise<{ rows: HistoryRow[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(1, Math.floor(query.limit || 50)), HISTORY_MAX_LIMIT);
  const offset = Math.max(0, Math.floor(query.offset || 0));
  const types = (query.types || []).filter(isHistoryDocType);
  const terms = historySearchTerms(query.q);

  const scoped = (cols: string) => {
    let b = historyBase(service, cols);
    if (query.customerId) b = b.eq('customer_id', query.customerId);
    if (types.length) b = b.in('doc_type', types);
    return b;
  };

  let matched = new Map<string, string>();
  let headers: HeaderRow[];
  let hasMore: boolean;

  if (terms.length === 0) {
    const { data, error } = await scoped(HEADER_COLS)
      .order('doc_date', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit);
    if (error) throw new Error(`Could not read QuickBooks history: ${error.message}`);
    headers = (data || []) as unknown as HeaderRow[];
    hasMore = headers.length > limit;
    headers = headers.slice(0, limit);
  } else {
    const phrase = terms.join(' ');
    matched = await lineMatches(service, terms, query.customerId || null);
    const orHeader = ['doc_number', 'party_name', 'po_number', 'memo']
      // Quoted, so a space or a dot in the phrase stays part of the value.
      .map(c => `${c}.ilike."*${phrase}*"`)
      .join(',');
    // Header matches and line matches, merged and ordered here: an .or()
    // spanning a second table isn't something PostgREST can express.
    const window = offset + limit + 1;
    const [byHeader, byLine] = await Promise.all([
      scoped(HEADER_COLS).or(orHeader)
        .order('doc_date', { ascending: false }).order('id', { ascending: false })
        .limit(window),
      Promise.all(chunk([...matched.keys()], IN_CHUNK).map(ids =>
        scoped(HEADER_COLS).in('id', ids)
          .order('doc_date', { ascending: false }).order('id', { ascending: false })
          .limit(window))),
    ]);
    if (byHeader.error) throw new Error(`Could not search QuickBooks history: ${byHeader.error.message}`);
    const lineRows: HeaderRow[] = [];
    for (const res of byLine) {
      if (res.error) throw new Error(`Could not search QuickBooks history: ${res.error.message}`);
      lineRows.push(...((res.data || []) as unknown as HeaderRow[]));
    }
    const merged = new Map<string, HeaderRow>();
    for (const r of [...((byHeader.data || []) as unknown as HeaderRow[]), ...lineRows]) merged.set(r.id, r);
    const all = [...merged.values()].sort((a, b) =>
      b.doc_date.localeCompare(a.doc_date) || b.id.localeCompare(a.id));
    hasMore = all.length > offset + limit;
    headers = all.slice(offset, offset + limit);
  }

  const pdfs = await storedPdfs(service, headers.map(h => h.id));
  const rows = headers.map(h => toRow(h, pdfs, matched)).filter((r): r is HistoryRow => !!r);
  return { rows, hasMore };
}

/** One QuickBooks document with its lines, PDF and attachments. */
export async function getHistoryDetail(service: SupabaseClient, id: string): Promise<HistoryDetail | null> {
  const { data: h, error } = await historyBase(
    service,
    `${HEADER_COLS}, ship_date, subtotal, tax_total, terms, customer_memo, class_name, bill_address, ship_address`,
  ).eq('id', id).maybeSingle();
  if (error) throw new Error(`Could not read the QuickBooks record: ${error.message}`);
  if (!h) return null;
  const head = h as unknown as HeaderRow & {
    ship_date: string | null; subtotal: number | string | null; tax_total: number | string | null;
    terms: string | null; customer_memo: string | null; class_name: string | null;
    bill_address: unknown; ship_address: unknown;
  };

  const [linesRes, docsRes] = await Promise.all([
    service.from('ledger_invoice_lines')
      .select('line_no, line_kind, item_name, item_number, description, quantity, unit_price, amount, service_date')
      .eq('document_id', id)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true }),
    service.from('ledger_documents')
      .select('id, kind, file_name, content_type, size_bytes')
      .eq('entity_table', 'ledger_invoices')
      .eq('entity_row_id', id)
      .eq('status', 'stored')
      .order('kind', { ascending: false })
      .order('file_name', { ascending: true }),
  ]);
  if (linesRes.error) throw new Error(`Could not read the lines: ${linesRes.error.message}`);
  if (docsRes.error) throw new Error(`Could not read the documents: ${docsRes.error.message}`);

  const documents: HistoryDocument[] = ((docsRes.data || []) as Array<{ id: string; kind: 'pdf' | 'attachment'; file_name: string; content_type: string | null; size_bytes: number | string | null }>)
    .map(d => ({ id: d.id, kind: d.kind, fileName: d.file_name, contentType: d.content_type, sizeBytes: d.size_bytes === null ? null : Number(d.size_bytes) }));
  const pdf = documents.find(d => d.kind === 'pdf');
  const base = toRow(head, new Map(pdf ? [[id, pdf.id]] : []), new Map());
  if (!base) return null;

  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    ...base,
    shipDate: head.ship_date,
    subtotal: num(head.subtotal),
    taxTotal: num(head.tax_total),
    terms: head.terms,
    customerMemo: head.customer_memo,
    className: head.class_name,
    billAddress: formatHistoryAddress(head.bill_address),
    shipAddress: formatHistoryAddress(head.ship_address),
    lines: ((linesRes.data || []) as Array<Record<string, any>>).map(l => ({
      lineNo: l.line_no ?? null,
      kind: String(l.line_kind),
      itemName: l.item_name ?? null,
      itemNumber: l.item_number ?? null,
      description: l.description ?? null,
      quantity: num(l.quantity),
      unitPrice: num(l.unit_price),
      amount: Number(l.amount) || 0,
      serviceDate: l.service_date ?? null,
    })),
    documents,
  };
}
