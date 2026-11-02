import type { SupabaseClient } from '@supabase/supabase-js';
import { transactionUrl } from '@/lib/netsuite';
import { DEFAULT_PNL_PERIOD, payrollAccountIds, PNL_PERIOD_KEYS, pnlPeriodDefs, type PnlPeriod, type PnlPeriodKey } from '@/lib/pnl';
import { fetchByIdChunks } from '@/lib/scan-log-load';
import { buildAgings, type Agings, type OpenDocumentsData } from './agings';
import {
  accountGroups, apRows, arRows, booksFinancials, booksPnlPeriod, MONEY_SCREENS_COMPANY, notOpenOf,
  type BooksAccountGroups, type BooksFinancials, type BooksSource, type DocLink, type DocumentFacts,
} from './money-screens';
import { chicagoDate } from './own-invoices';
import { partyBalances, type PartyBalancesData, type PartyKind } from './party-balances';
import { loadReports, type LoadedReports } from './report-data';
import type { ReportData } from './reports';
import { readTaxAccounts } from './sales-tax-data';
import type { OpenArInvoice, OpenVendorBill } from '@/lib/financials-data';

/**
 * What Home → Financials reads from FleetSuite's books with the switch on
 * (src/lib/books/money-screens.ts): the tab's summary, the lists behind its
 * tiles, and one period of its profit and loss band, each for BMG alone.
 * A read that fails comes back as { error }. Financial History reads BMG's
 * books here too (loadBooksForHistory).
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

/** Each open document's total and PO (invoices) or memo (bills), from the copy of NetSuite's documents. */
async function readFacts(service: SupabaseClient, kind: PartyKind, agings: Agings): Promise<Map<string, DocumentFacts>> {
  const ids = agings.parties.flatMap((p) => p.documents.filter((d) => d.open.fleetsuite).map((d) => d.doc));
  const table = kind === 'customer' ? 'ledger_invoices' : 'ledger_bills';
  const note = kind === 'customer' ? 'po_number' : 'memo';
  const { data, error } = await fetchByIdChunks<Record<string, unknown>>(ids, (chunk, from, to) => service
    .from(table)
    .select(`id, external_id, total, ${note}`)
    .eq('source', 'netsuite')
    .in('external_id', chunk)
    .order('id', { ascending: true })
    .range(from, to));
  if (error) throw new Error(error.message);
  return new Map(data.map((r) => [String(r.external_id), {
    total: Math.abs(Number(r.total) || 0),
    note: typeof r[note] === 'string' && r[note] ? String(r[note]) : null,
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
    const invoices = arRows(customers, await readFacts(service, 'customer', customers), link);
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
    const bills = apRows(vendors, await readFacts(service, 'vendor', vendors), link);
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
