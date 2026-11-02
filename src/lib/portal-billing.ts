import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchStatementInvoices, type StatementInvoice } from './financials-data';
import type { AgingBucketKey } from './financials-data';
import { loadBooksPortalInvoices } from './books/money-screens-data';
import { switchIsOn } from './books/switches';

/**
 * Portal billing data (R5-14): the customer-safe billing projection behind
 * the tokenized portal's Billing section and the logged-in customer
 * dashboard's billing card. Keys strictly on the customer's NetSuite
 * entity id — no name matching, nothing internal in the payload.
 *
 * Live SuiteQL sits behind a shareable public link, so results are cached
 * per customer for a few minutes (module-scope, best-effort on
 * serverless): a customer refreshing their portal shouldn't re-run the
 * open-AR query every click, and the cache is also what the invoice-PDF
 * route uses to verify an invoice id BELONGS to the token's customer
 * before fetching the PDF (the IDOR check).
 *
 * With Portal billing on FleetSuite's books on (Books → Switches, migration
 * 505, docs/books.md "The portal"), the open invoices come from BMG's books
 * in FleetSuite instead (src/lib/books/money-screens-data.ts), still keyed
 * on the NetSuite id, as of when the books last caught up with NetSuite. A
 * read of the books that fails throws: there's no falling back to NetSuite.
 */

export interface PortalInvoiceRow {
  id: string; // NetSuite internal id — the PDF fetch key
  tranid: string;
  date: string | null;
  dueDate: string | null;
  po: string | null;
  total: number;
  unpaid: number;
  daysPastDue: number;
}

export interface PortalBilling {
  balance: number;
  pastDue: number;
  invoiceCount: number;
  aging: Record<AgingBucketKey, number>;
  invoices: PortalInvoiceRow[];
  generatedAt: string;
  /** For BMG's books, when they last caught up with NetSuite, which is what the amounts are as of. Not set for NetSuite's, read live. */
  asOf?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: PortalBilling; raw: StatementInvoice[] }>();

/** Pure fold used by both surfaces — open invoices → balance + aging (and when they're as of, for BMG's books). */
export function summarizePortalBilling(invoices: StatementInvoice[], asOf?: string): PortalBilling {
  const aging: Record<AgingBucketKey, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  let balance = 0, pastDue = 0;
  for (const inv of invoices) {
    balance += inv.unpaid;
    if (inv.daysPastDue > 0) pastDue += inv.unpaid;
    if (inv.bucket in aging) aging[inv.bucket as AgingBucketKey] += inv.unpaid;
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  for (const k of Object.keys(aging) as AgingBucketKey[]) aging[k] = round(aging[k]);
  return {
    balance: round(balance),
    pastDue: round(pastDue),
    invoiceCount: invoices.length,
    aging,
    invoices: [...invoices]
      .sort((a, b) => (a.dueDate || a.date || '').localeCompare(b.dueDate || b.date || ''))
      .map(i => ({
        id: String(i.id),
        tranid: i.tranid,
        date: i.date,
        dueDate: i.dueDate,
        po: i.po || null,
        total: round(i.total),
        unpaid: round(i.unpaid),
        daysPastDue: i.daysPastDue,
      })),
    generatedAt: new Date().toISOString(),
    asOf,
  };
}

/** The customer's billing from NetSuite, or from BMG's books with the switch on; cached per customer and source. */
export async function loadPortalBilling(service: SupabaseClient, netsuiteId: string, opts?: { fresh?: boolean }): Promise<{
  billing: PortalBilling;
  raw: StatementInvoice[];
}> {
  const id = String(netsuiteId);
  if (!/^\d{1,15}$/.test(id)) throw new Error('Invalid entity id');
  const books = await switchIsOn(service, 'portal_books');
  // Keyed by source too, so switching never serves the other's cached answer.
  const key = `${books ? 'books' : 'netsuite'}:${id}`;
  const hit = cache.get(key);
  if (!opts?.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { billing: hit.data, raw: hit.raw };
  }
  const { invoices, asOf } = books
    ? await loadBooksPortalInvoices(service, id)
    : { ...await fetchStatementInvoices(id, { scope: 'open' }), asOf: undefined };
  const billing = summarizePortalBilling(invoices, asOf);
  cache.set(key, { at: Date.now(), data: billing, raw: invoices });
  return { billing, raw: invoices };
}

/** True only when this open invoice id belongs to this customer — the guard
 *  every tokenized PDF fetch must pass. */
export async function invoiceBelongsToCustomer(service: SupabaseClient, netsuiteId: string, invoiceId: string): Promise<boolean> {
  const { raw } = await loadPortalBilling(service, netsuiteId);
  return raw.some(i => String(i.id) === String(invoiceId));
}
