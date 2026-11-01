import type { SupabaseClient } from '@supabase/supabase-js';
import { getSalesTaxRate } from '@/lib/sales-tax';
import type { TaxAccountCount } from './invoice-check';
import { valueMonth } from './inventory-value-data';
import { COPY_FROM } from './netsuite-gl';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { pct } from './own-invoice-check';
import {
  dueDate, holdReturn, locationState, readRates, readReturn, salesTaxWorksheet,
  type FiledReturn, type ReturnHeld, type SalesTaxMonthData, type SalesTaxRate, type SalesTaxRateRow, type SalesTaxReturnRow,
  type SalesTaxWorksheet,
} from './sales-tax-worksheet';

/**
 * What Books → Sales tax and its Excel download read (part 65,
 * src/app/api/admin/books/sales-tax and its download): the month's
 * invoices, credit memos and cash sales with their lines, customers and the
 * sales tax accounts (gl_sales_tax_month, migration 496), each location's
 * dated rates, the month's return as filed, and where NetSuite posts sales
 * tax (src/lib/books/netsuite-lists.ts's tax accounts), worked out into the
 * month's worksheet (sales-tax-worksheet.ts).
 */

/** Missouri's return is BMG's: 1084 Cool Springs makes no sales. */
export const SALES_TAX_COMPANY = 'BMG';

/** The other moves on the sales tax accounts listed, in the month and in the month after. */
export const OTHERS_SHOWN = 100;

export interface RateShown extends SalesTaxRate {
  enteredBy: string | null;
  enteredAt: string;
}

export interface ReturnShown extends FiledReturn {
  enteredBy: string | null;
  enteredAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

/** A NetSuite location a rate can be added for: any not in Georgia. */
export interface LocationChoice {
  id: string;
  name: string;
  state: string;
}

export interface LoadedSalesTax {
  /** The month asked for, 'YYYY-MM-01'; last month by default. */
  month: string;
  /** When its return is due. */
  due: string;
  /** The months it can be: January 2025 through this one. */
  first: string;
  through: string;
  company: { code: string; name: string; legal_name: string | null };
  worksheet: SalesTaxWorksheet;
  rates: RateShown[];
  locations: LocationChoice[];
  /** NetSuite's sales tax accounts as FleetSuite's chart names them. */
  taxAccounts: Array<{ id: string; number: string | null; name: string }>;
  /** Settings → Sales Tax, the one rate quotes use. */
  settingsPct: string;
  filed: ReturnShown | null;
  held: ReturnHeld | null;
}

interface RateRow extends SalesTaxRateRow {
  entered_by: string | null;
  entered_at: string;
}

interface ReturnRow extends SalesTaxReturnRow {
  entered_by: string | null;
  entered_at: string;
  updated_by: string | null;
  updated_at: string;
}

export const RETURN_COLUMNS = 'company, month, filed_on, gross_cents, adjustments_cents, taxable_cents, tax_cents, allowance_cents, paid_cents, note, '
  + 'entered_by, entered_at, updated_by, updated_at';

/** The accounts NetSuite posts sales tax to, from the last read of its lists; null when they haven't been read. */
export async function readTaxAccounts(service: SupabaseClient): Promise<string[] | null> {
  const { data, error } = await service.from('sync_state').select('last_result').eq('sync_type', BOOKS_LISTS_SYNC).maybeSingle();
  if (error) throw new Error(`Couldn't read where NetSuite posts sales tax: ${error.message}`);
  const counts = ((data?.last_result ?? null) as { taxAccounts?: TaxAccountCount[] } | null)?.taxAccounts;
  if (!Array.isArray(counts)) return null;
  return [...new Set(counts.map((c) => String(c.account_id)).filter((id) => /^\d+$/.test(id)))].sort();
}

async function readNames(service: SupabaseClient, ids: Array<string | null>): Promise<Map<string, string>> {
  const people = [...new Set(ids.filter((p): p is string => !!p))];
  if (!people.length) return new Map();
  const { data, error } = await service.from('profiles').select('id, full_name').in('id', people);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name || 'Someone']));
}

export async function loadSalesTax(
  service: SupabaseClient,
  params: URLSearchParams,
  today = new Date().toISOString().slice(0, 10),
): Promise<LoadedSalesTax | { error: string }> {
  const { month, through } = valueMonth(params, today);
  try {
    const taxAccounts = await readTaxAccounts(service);
    const [read, company, rateRows, returnRow, chart, locations, settingsRate] = await Promise.all([
      service.rpc('gl_sales_tax_month', { p_company: SALES_TAX_COMPANY, p_month: month, p_tax_accounts: taxAccounts ?? [], p_limit: OTHERS_SHOWN }),
      service.from('gl_companies').select('code, name, legal_name').eq('code', SALES_TAX_COMPANY).maybeSingle(),
      service.from('sales_tax_rates').select('location_id, starts_on, rate_pct, note, entered_by, entered_at').order('location_id').order('starts_on'),
      service.from('sales_tax_returns').select(RETURN_COLUMNS).eq('company', SALES_TAX_COMPANY).eq('month', month).maybeSingle(),
      taxAccounts?.length
        ? service.from('gl_accounts').select('netsuite_account_id, number, name').in('netsuite_account_id', taxAccounts)
        : Promise.resolve({ data: [], error: null }),
      service.from('gl_netsuite_lists').select('netsuite_id, name').eq('kind', 'location').is('gone_at', null),
      getSalesTaxRate(service),
    ]);
    for (const [what, res] of [
      ["the month's documents", read], ['the company', company], ['the rates', rateRows], ["the month's return", returnRow],
      ['the sales tax accounts', chart], ["NetSuite's locations", locations],
    ] as const) {
      if (res.error) return { error: `Couldn't read ${what}: ${res.error.message}` };
    }

    const rows = (rateRows.data ?? []) as RateRow[];
    const filedRow = returnRow.data as ReturnRow | null;
    const names = await readNames(service, [
      ...rows.map((r) => r.entered_by), filedRow?.entered_by ?? null, filedRow?.updated_by ?? null,
    ]);
    const nameOf = (id: string | null) => (id ? names.get(id) ?? 'Someone' : null);

    const rates = readRates(rows);
    const enteredOf = new Map(rows.map((r) => [`${r.location_id}|${String(r.starts_on).slice(0, 10)}`, r]));
    const worksheet = salesTaxWorksheet(month, read.data as SalesTaxMonthData, { rates, taxAccounts });
    const filed = filedRow ? readReturn(filedRow) : null;
    const rated = new Set(rates.map((r) => r.locationId));
    return {
      month,
      due: dueDate(month),
      first: COPY_FROM,
      through,
      company: (company.data as LoadedSalesTax['company'] | null) ?? { code: SALES_TAX_COMPANY, name: SALES_TAX_COMPANY, legal_name: null },
      worksheet,
      rates: rates.map((r) => {
        const row = enteredOf.get(`${r.locationId}|${r.startsOn}`);
        return { ...r, enteredBy: nameOf(row?.entered_by ?? null), enteredAt: row?.entered_at ?? '' };
      }),
      locations: ((locations.data ?? []) as Array<{ netsuite_id: string; name: string }>)
        .map((l) => ({ id: l.netsuite_id, name: l.name, state: locationState(l.netsuite_id, l.name, rated.has(l.netsuite_id)) }))
        .filter((l) => l.state !== 'GA')
        .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })),
      taxAccounts: ((chart.data ?? []) as Array<{ netsuite_account_id: string; number: string | null; name: string }>)
        .map((a) => ({ id: a.netsuite_account_id, number: a.number, name: a.name }))
        .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '') || a.name.localeCompare(b.name)),
      settingsPct: pct(settingsRate),
      filed: filed && filedRow && {
        ...filed,
        enteredBy: nameOf(filedRow.entered_by), enteredAt: filedRow.entered_at, updatedBy: nameOf(filedRow.updated_by), updatedAt: filedRow.updated_at,
      },
      held: filed && holdReturn(filed, worksheet.figures, worksheet.accounts),
    };
  } catch (err) {
    return { error: String((err as Error)?.message || err) };
  }
}
