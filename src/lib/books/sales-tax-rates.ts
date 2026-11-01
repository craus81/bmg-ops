/**
 * Sales tax rates (migration 496's sales_tax_rates, docs/books.md "Sales
 * tax"): each NetSuite location's rate from the day it starts until the next
 * one. The month's Missouri worksheet (sales-tax-worksheet.ts) taxes each
 * document at its location's rate on its date, and since part 66 so does
 * FleetSuite's own copy of each invoice it makes (own-invoices.ts). Pure, and
 * imports nothing from the other Books files, so both can use it.
 */

/** A NetSuite tax code's rate, a percent ('8.238%' or '8.238'), as a fraction; null when there isn't one to read. */
export function parseRate(text: string | null | undefined): number | null {
  const cleaned = String(text ?? '').replace(/%/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n / 100 : null;
}

/** '8.238%' from 0.08238. */
export function pct(rate: number): string {
  return `${Number((rate * 100).toFixed(4))}%`;
}

/** A row of sales_tax_rates. */
export interface SalesTaxRateRow {
  location_id: string;
  starts_on: string;
  rate_pct: string | number;
  note: string | null;
}

export interface SalesTaxRate {
  locationId: string;
  startsOn: string;
  /** A fraction: 0.08488 is 8.488%. */
  rate: number;
  /** As people write it: '8.488%'. */
  pct: string;
  note: string | null;
}

const byId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export function readRates(rows: SalesTaxRateRow[]): SalesTaxRate[] {
  return rows
    .map((r) => {
      const rate = parseRate(String(r.rate_pct)) ?? 0;
      return { locationId: String(r.location_id), startsOn: String(r.starts_on).slice(0, 10), rate, pct: pct(rate), note: r.note };
    })
    .sort((a, b) => byId(a.locationId, b.locationId) || a.startsOn.localeCompare(b.startsOn));
}

/** The rate in force at a location on a day: the one that started last, on or before it; null when none has. */
export function rateOn(rates: SalesTaxRate[], locationId: string | null, day: string): SalesTaxRate | null {
  let found: SalesTaxRate | null = null;
  for (const r of rates) {
    if (r.locationId === locationId && r.startsOn <= day && (!found || r.startsOn > found.startsOn)) found = r;
  }
  return found;
}
