import type { SupabaseClient } from '@supabase/supabase-js';
import { transactionUrl } from '@/lib/netsuite';
import { DEFAULT_PNL_PERIOD, payrollAccountIds, PNL_PERIOD_KEYS, pnlPeriodDefs, type PnlPeriod, type PnlPeriodKey } from '@/lib/pnl';
import { fetchByIdChunks } from '@/lib/scan-log-load';
import { buildAgings, type AgedDocument, type Agings, type OpenDocumentsData } from './agings';
import { BOOKS_INVOICE_POSTING } from './invoice-posting';
import {
  accountGroups, apRows, arRows, booksFinancials, booksPnlPeriod, MONEY_SCREENS_COMPANY, notOpenOf, portalAsOf, portalInvoices,
  type BooksAccountGroups, type BooksFinancials, type BooksSource, type DocLink, type DocumentFacts,
} from './money-screens';
import { BOOKS_GL_SYNC } from './netsuite-gl';
import { BOOKS_OPEN_ITEMS_SYNC } from './netsuite-open-items';
import { chicagoDate } from './own-invoices';
import { partyBalances, type PartyBalancesData, type PartyKind } from './party-balances';
import { loadReports, type LoadedReports } from './report-data';
import type { ReportData } from './reports';
import { readTaxAccounts } from './sales-tax-data';
import type { OpenArInvoice, OpenVendorBill, StatementInvoice } from '@/lib/financials-data';

/**
 * What Home → Financials reads from FleetSuite's books with the switch on
 * (src/lib/books/money-screens.ts): the tab's summary, the lists behind its
 * tiles, and one period of its profit and loss band, each for BMG alone.
 * A read that fails comes back as { error }. Financial History reads BMG's
 * books here too (loadBooksForHistory), and so does the customer portal's
 * billing (loadBooksPortalInvoices).
 */

const COMPANY = MONEY_SCREENS_COMPANY;

const message = (err: unknown) => String((err as Error)?.message || err);

/** NetSuite's page for a document, or '' when NetSuite can't be linked to. */
const link: DocLink = (page, id) => {
  try {
    return transactionUrl(page, id);
  } catch {
    return '';
  }
};

/** The chart and the books' totals for BMG, as Reports reads them; an error when BMG has no books. */
async function readBooks(service: SupabaseClient): Promise<LoadedReports> {
  const loaded = await loadReports(service, COMPANY);
  if ('error' in loaded) throw new Error(loaded.error);
  if (loaded.company !== COMPANY) throw new Error(`FleetSuite's books have no company ${COMPANY}`);
  return loaded;
}

function sourceOf(loaded: LoadedReports): BooksSource {
  return {
    company: COMPANY,
    name: loaded.companies.find((c) => c.code === COMPANY)?.name ?? COMPANY,
    postedAt: loaded.lastPosting?.at ?? null,
    postingError: loaded.lastPosting?.error ?? null,
    postingPartial: loaded.lastPosting?.partial ?? false,
  };
}

async function readGroups(service: SupabaseClient, loaded: LoadedReports): Promise<BooksAccountGroups> {
  return accountGroups(loaded.data, loaded.through, await readTaxAccounts(service));
}

/** Each customer's or vendor's balance, as Books → AR and AP agings reads it. */
async function readBalances(service: SupabaseClient, kind: PartyKind) {
  const { data, error } = await service.rpc('gl_party_balances', { p_company: COMPANY, p_kind: kind });
  if (error) throw new Error(error.message);
  return partyBalances(data as PartyBalancesData, kind);
}

/** One kind's aging today, with every open document, as Books → AR and AP agings reads it. */
async function readAgings(service: SupabaseClient, kind: PartyKind): Promise<Agings> {
  const [balances, open] = await Promise.all([
    readBalances(service, kind),
    service.rpc('gl_party_open_documents', { p_company: COMPANY, p_kind: kind }),
  ]);
  if (open.error) throw new Error(open.error.message);
  return buildAgings(balances, open.data as OpenDocumentsData, kind, chicagoDate());
}

/** Every document with something open on it in FleetSuite's books. */
const openDocuments = (agings: Agings) => agings.parties.flatMap((p) => p.documents.filter((d) => d.open.fleetsuite));

/**
 * Each document's total and PO (invoices) or memo (bills), by NetSuite's id,
 * from the copies of NetSuite's documents: the ledger mirror's invoices and
 * credit memos, keyed by type and id (CustInvc/501), with NetSuite's id for
 * each one's customer, and the books' copy of NetSuite's bills and bill
 * credits. A document only FleetSuite's books have has neither.
 */
async function readFacts(service: SupabaseClient, kind: PartyKind, documents: AgedDocument[]): Promise<Map<string, DocumentFacts>> {
  const { data, error } = kind === 'customer'
    ? await fetchByIdChunks<Record<string, unknown>>(documents.map((d) => `${d.type}/${d.doc}`), (chunk, from, to) => service
      .from('ledger_invoices')
      .select('id, external_ref, total, po_number, customer_netsuite_id')
      .eq('source', 'netsuite')
      .in('external_id', chunk)
      .order('id', { ascending: true })
      .range(from, to))
    : await fetchByIdChunks<Record<string, unknown>>(documents.map((d) => d.doc), (chunk, from, to) => service
      .from('gl_netsuite_bills')
      .select('netsuite_id, total, memo')
      .in('netsuite_id', chunk)
      .order('netsuite_id', { ascending: true })
      .range(from, to));
  if (error) throw new Error(error.message);
  const [id, note] = kind === 'customer' ? ['external_ref', 'po_number'] : ['netsuite_id', 'memo'];
  return new Map(data.map((r) => [String(r[id]), {
    total: Math.abs(Number(r.total) || 0),
    note: typeof r[note] === 'string' && r[note] ? String(r[note]) : null,
    ...(kind === 'customer' ? { customer: r.customer_netsuite_id ? String(r.customer_netsuite_id) : null } : {}),
  }]));
}

/** The tab's summary from BMG's books. */
export async function loadBooksFinancials(service: SupabaseClient): Promise<BooksFinancials | { error: string }> {
  try {
    const [loaded, customers, vendors] = await Promise.all([
      readBooks(service),
      readAgings(service, 'customer'),
      readBalances(service, 'vendor'),
    ]);
    const groups = await readGroups(service, loaded);
    return booksFinancials(groups, customers, vendors.totals.fleetsuite, sourceOf(loaded));
  } catch (err) {
    return { error: `Couldn't read FleetSuite's books: ${message(err)}` };
  }
}

/** Every open invoice and credit memo, most overdue first, then the largest. */
export async function loadBooksArInvoices(service: SupabaseClient): Promise<{
  success: true; unpaidColumn: true; invoices: OpenArInvoice[]; notOpen: number;
} | { error: string }> {
  try {
    const customers = await readAgings(service, 'customer');
    const invoices = arRows(customers, await readFacts(service, 'customer', openDocuments(customers)), link);
    invoices.sort((a, b) => b.daysPastDue - a.daysPastDue || b.unpaid - a.unpaid);
    return { success: true, unpaidColumn: true, invoices, notOpen: notOpenOf(customers) };
  } catch (err) {
    return { error: `Couldn't read FleetSuite's books: ${message(err)}` };
  }
}

/** Every open bill and bill credit, most overdue first, then the largest. */
export async function loadBooksApBills(service: SupabaseClient): Promise<{
  success: true; unpaidColumn: true; bills: OpenVendorBill[]; notOpen: number;
} | { error: string }> {
  try {
    const vendors = await readAgings(service, 'vendor');
    const bills = apRows(vendors, await readFacts(service, 'vendor', openDocuments(vendors)), link);
    bills.sort((a, b) => b.daysPastDue - a.daysPastDue || b.unpaid - a.unpaid);
    return { success: true, unpaidColumn: true, bills, notOpen: notOpenOf(vendors) };
  } catch (err) {
    return { error: `Couldn't read FleetSuite's books: ${message(err)}` };
  }
}

/** The bank, card, payable and sales tax accounts behind the tiles. */
export async function loadBooksAccounts(service: SupabaseClient): Promise<BooksAccountGroups | { error: string }> {
  try {
    return await readGroups(service, await readBooks(service));
  } catch (err) {
    return { error: `Couldn't read FleetSuite's books: ${message(err)}` };
  }
}

/**
 * One period of the profit and loss band from BMG's books, in the shape
 * loadPnlPeriod answers with NetSuite's; a read that fails says so in the
 * period's error, as NetSuite's does.
 */
export async function loadBooksPnlPeriod(service: SupabaseClient, key: PnlPeriodKey = DEFAULT_PNL_PERIOD): Promise<{
  period: PnlPeriod;
  options: { key: PnlPeriodKey; label: string }[];
  payrollConfigured: boolean;
  books: BooksSource;
}> {
  const defs = pnlPeriodDefs(chicagoDate());
  const def = defs[key] ?? defs[DEFAULT_PNL_PERIOD];
  const ids = payrollAccountIds();
  const shared = { options: PNL_PERIOD_KEYS.map((k) => ({ key: k, label: defs[k].label })), payrollConfigured: ids.size > 0 };
  try {
    const [loaded, collected] = await Promise.all([
      readBooks(service),
      service.rpc('gl_books_collections', { p_company: COMPANY, p_from: def.from, p_to: def.to }),
    ]);
    if (collected.error) throw new Error(collected.error.message);
    const read = collected.data as { total: string; count: number } | null;
    const collections = read ? { total: Number(read.total) || 0, count: Number(read.count) || 0 } : null;
    return { period: booksPnlPeriod(loaded.data, def, ids, collections), ...shared, books: sourceOf(loaded) };
  } catch (err) {
    return {
      period: { ...def, pnl: null, collections: null, error: `Couldn't read FleetSuite's books: ${message(err)}` },
      ...shared,
      books: { company: COMPANY, name: COMPANY, postedAt: null, postingError: null, postingPartial: false },
    };
  }
}

/**
 * BMG's books as Books → Reports reads them, and whose they are, for
 * Financial History (src/lib/financial-history.ts and its year
 * cross-check). A read that fails throws, naming FleetSuite's books.
 */
export async function loadBooksForHistory(service: SupabaseClient): Promise<{ data: ReportData; books: BooksSource }> {
  try {
    const loaded = await readBooks(service);
    return { data: loaded.data, books: sourceOf(loaded) };
  } catch (err) {
    throw new Error(`Couldn't read FleetSuite's books: ${message(err)}`);
  }
}

/** NetSuite's id for each open invoice's customer in the copy of NetSuite's open items, by NetSuite's id for the invoice. */
async function readOpenItemCustomers(service: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const { data, error } = await fetchByIdChunks<{ netsuite_id: string; entity_id: string }>(ids, (chunk, from, to) => service
    .from('gl_netsuite_open_items')
    .select('netsuite_id, entity_id')
    .in('netsuite_id', chunk)
    .order('netsuite_id', { ascending: true })
    .range(from, to));
  if (error) throw new Error(error.message);
  return new Map(data.filter((r) => r.entity_id).map((r) => [String(r.netsuite_id), String(r.entity_id)]));
}

/** When the copy of NetSuite's general ledger, the posting run and the copy of NetSuite's open items last finished a run. */
async function readCaughtUp(service: SupabaseClient): Promise<{ copied: string | null; posted: string | null; open: string | null }> {
  const { data, error } = await service
    .from('sync_state')
    .select('sync_type, last_synced_at')
    .in('sync_type', [BOOKS_GL_SYNC, BOOKS_INVOICE_POSTING, BOOKS_OPEN_ITEMS_SYNC]);
  if (error) throw new Error(error.message);
  const at = (type: string) => (data as Array<{ sync_type: string; last_synced_at: string | null }> | null)
    ?.find((r) => r.sync_type === type)?.last_synced_at ?? null;
  return { copied: at(BOOKS_GL_SYNC), posted: at(BOOKS_INVOICE_POSTING), open: at(BOOKS_OPEN_ITEMS_SYNC) };
}

/**
 * One customer's open invoices in BMG's books, for the customer portal's
 * billing with Portal billing on FleetSuite's books on
 * (src/lib/portal-billing.ts): the invoices NetSuite names the customer on
 * (portalInvoices), NetSuite's id for each one's customer taken from the
 * copy of NetSuite's open items, else the ledger mirror's copy of the
 * invoice; and when the books last caught up with NetSuite (portalAsOf).
 * What the books can't say for sure throws, naming FleetSuite's books: a
 * read that fails, BMG not linked to its NetSuite subsidiary, books more
 * than a day behind.
 */
export async function loadBooksPortalInvoices(service: SupabaseClient, netsuiteId: string): Promise<{ invoices: StatementInvoice[]; asOf: string }> {
  try {
    const [customers, times] = await Promise.all([readAgings(service, 'customer'), readCaughtUp(service)]);
    const asOf = portalAsOf(times, Date.now());
    if (!customers.linked) throw new Error(`${COMPANY} isn't linked to its NetSuite subsidiary`);
    const invoices = openDocuments(customers).filter((d) => d.type === 'CustInvc');
    const [named, facts] = await Promise.all([
      readOpenItemCustomers(service, invoices.map((d) => d.doc)),
      readFacts(service, 'customer', invoices),
    ]);
    const customerOf = new Map([...facts].flatMap(([id, f]) => (f.customer ? [[id, f.customer] as [string, string]] : [])));
    for (const [id, customer] of named) customerOf.set(id, customer);
    return { invoices: portalInvoices(customers, netsuiteId, customerOf, facts, link), asOf };
  } catch (err) {
    throw new Error(`Couldn't read FleetSuite's books: ${message(err)}`);
  }
}
