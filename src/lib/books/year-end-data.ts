import type { SupabaseClient } from '@supabase/supabase-js';
import { readCompanies, type CompanyRow } from './going-live';
import { BOOKS_COMPANIES } from './journal';
import { readMonthFacts } from './months';
import { loadReports, type LoadedReports } from './report-data';
import { yearCloseAmounts, type YearCloseAmounts } from './reports';
import { SALES_TAX_COMPANY } from './sales-tax-data';
import { defaultYear, readYearChecks, readYears, yearsShown, type YearFacts } from './year-end';

/**
 * What Books → Year end and its year-end package read for one company's
 * year (src/app/api/admin/books/year-end and its download; docs/books.md
 * "Year end"): the company and year asked for, the year's close both sides,
 * its months, checks and closes, and the books Reports reads, which the
 * package's statements come from.
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
