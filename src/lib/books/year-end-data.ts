import type { SupabaseClient } from '@supabase/supabase-js';
import { generalLedger, ledgerAccounts, type LedgerBlock } from './general-ledger';
import { readCompanies, type CompanyRow } from './going-live';
import { BOOKS_COMPANIES } from './journal';
import { readMonthFacts } from './months';
import { loadReports, type LoadedReports } from './report-data';
import { DOCUMENTS_LISTED, type AccountDocumentsData } from './report-detail';
import { yearCloseAmounts, type YearCloseAmounts } from './reports';
import { SALES_TAX_COMPANY } from './sales-tax-data';
import { defaultYear, readYearChecks, readYears, yearsShown, type YearFacts } from './year-end';

/**
 * What Books → Year end and its year-end package read for one company's
 * year (src/app/api/admin/books/year-end and its download; docs/books.md
 * "Year end"): the company and year asked for, the year's close both sides,
 * its months, checks and closes, and the books Reports reads, which the
 * package's statements come from; and for the package, the general ledger.
 */

export interface YearRead {
  company: CompanyRow;
  facts: YearFacts;
  amounts: YearCloseAmounts;
  /** NetSuite's side is known: a copy has read its totals. */
  checked: boolean;
  /** What Reports reads for the company. */
  loaded: LoadedReports;
}

/** The companies with books of their own, by code. */
export const booksCompanies = async (service: SupabaseClient) =>
  (await readCompanies(service)).filter((c) => (BOOKS_COMPANIES as readonly string[]).includes(c.code));

/**
 * The company and year a request asks for (company=, year=): the company
 * asked for, else BMG, else the first; the year asked for when Year end
 * lists it, else last year. Null with no companies.
 */
export function pickYear(companies: CompanyRow[], params: URLSearchParams, today: string): { company: CompanyRow; year: number; years: number[] } | null {
  const asked = params.get('company');
  const company = companies.find((c) => c.code === asked) ?? companies.find((c) => c.code === 'BMG') ?? companies[0];
  if (!company) return null;
  const years = yearsShown(today);
  const askedYear = Number(params.get('year'));
  return { company, year: years.includes(askedYear) ? askedYear : defaultYear(today), years };
}

/** Everything a company's year shows, read as it is now: the close's amounts both sides, its months, checks and closes. */
export async function readYear(service: SupabaseClient, company: CompanyRow, year: number, today: string): Promise<YearRead> {
  const loaded = await loadReports(service, company.code);
  if ('error' in loaded) throw new Error(loaded.error);
  const chart = new Map(loaded.data.accounts.filter((a) => a.netsuite_account_id).map((a) => [a.netsuite_account_id!, a]));
  const accountName = (id: string) => {
    const a = chart.get(id);
    return a ? [a.number, a.name].filter(Boolean).join(' ') : `NetSuite account ${id}`;
  };
  const [{ periods, compared }, years, checks] = await Promise.all([
    readMonthFacts(service, company),
    readYears(service, company.id),
    readYearChecks(service, { company: company.code, year, makesSales: company.code === SALES_TAX_COMPANY, accountName }),
  ]);
  return {
    company,
    facts: { name: company.name, liveFrom: company.books_live_from, year, today, periods, compared, years, ...checks },
    amounts: yearCloseAmounts(loaded.data, year),
    checked: loaded.data.opening.length > 0 || loaded.data.netsuite.length > 0,
    loaded,
  };
}

/** How many accounts' documents the general ledger reads at once. */
const LEDGER_READS = 4;

/**
 * The general ledger for the months from `from` through `to`
 * (generalLedger in general-ledger.ts): the documents of each account that
 * moved in them, read as the account's own download reads them
 * (gl_books_account_documents, migration 460), at most 20,000 an account, a
 * few accounts at a time.
 */
export async function readLedger(service: SupabaseClient, loaded: LoadedReports, range: { from: string; to: string }): Promise<LedgerBlock[]> {
  const waiting = ledgerAccounts(loaded.data, range).filter((a) => a.moved).map((a) => a.key);
  const found = new Map<string, AccountDocumentsData>();
  const reader = async () => {
    for (let key = waiting.shift(); key !== undefined; key = waiting.shift()) {
      const { data, error } = await service.rpc('gl_books_account_documents', {
        p_company: loaded.company, p_account: key, p_from: range.from, p_to: range.to, p_differs: false, p_limit: DOCUMENTS_LISTED,
      });
      if (error) {
        // The other readers stop at their next account.
        waiting.length = 0;
        throw new Error(error.message);
      }
      found.set(key, data as AccountDocumentsData);
    }
  };
  await Promise.all(Array.from({ length: LEDGER_READS }, reader));
  return generalLedger(loaded.data, range, found);
}
