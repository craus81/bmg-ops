/**
 * Sales by location and class (Books → Sales by location, migration 426,
 * docs/books.md).
 *
 * Built 2026-10-22 for Liberty Mutual's premium audit, which asks for gross
 * sales by originating location (state) and product type with returns,
 * discounts and transportation charges apart. It reads NetSuite's own ledger
 * lines on income accounts (gl_sales_lines), so its net total is the income
 * on NetSuite's profit and loss for the same months, and sorts each amount
 * into one column:
 *   * returns: credit memos and cash refunds;
 *   * discounts: lines on an account named for discounts, debits on an
 *     invoice or cash sale (NetSuite's discount items and negative lines),
 *     and discounts taken on customer payments;
 *   * transportation: lines on an account named for freight, shipping or
 *     delivery;
 *   * other: journal entries and anything else that moves an income account;
 *   * gross sales: the rest, an invoice's or cash sale's credits.
 * Amounts are in cents, income positive; returns and discounts are shown as
 * the reductions they are (negative).
 */

export interface SalesLine {
  tran_type: string;
  account: string;
  account_number: string | null;
  account_name: string;
  location_id: string | null;
  location: string | null;
  class_id: string | null;
  class: string | null;
  debit: string;
  credit: string;
  lines: number;
}

export type SalesColumn = 'gross' | 'returns' | 'discounts' | 'transportation' | 'other';
export const SALES_COLUMNS: readonly SalesColumn[] = ['gross', 'returns', 'discounts', 'transportation', 'other'];

export type SalesAmounts = Record<SalesColumn, number> & { net: number };

export interface SalesRow extends SalesAmounts {
  state: string;
  location: string;
  class: string;
}

export interface SalesAccountRow extends SalesAmounts {
  account: string;
  number: string | null;
  name: string;
}

export interface SalesStateRow extends SalesAmounts {
  state: string;
}

export interface SalesReport {
  rows: SalesRow[];
  states: SalesStateRow[];
  accounts: SalesAccountRow[];
  total: SalesAmounts;
}

/**
 * The state each of BMG's NetSuite locations is in (src/lib/invoice-location.ts
 * names them): the shop in O'Fallon, the crews at Masterack's plants in
 * Wentzville and Kansas City, and Masterack's plant in Social Circle.
 */
const LOCATION_STATES: Record<string, string> = {
  ofallon: 'MO',
  wentzville: 'MO',
  kansascity: 'MO',
  socialcircle: 'GA',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export const NO_LOCATION = 'No location';
export const NO_CLASS = 'No class';

/** A location's state, by its name; a location the list doesn't know has none. */
export function stateOf(location: string | null): string {
  if (!location) return '—';
  const name = norm(location);
  const known = Object.entries(LOCATION_STATES).find(([key]) => name.includes(key));
  return known ? known[1] : '—';
}

const RETURNS = new Set(['CustCred', 'CashRfnd']);
const SALES = new Set(['CustInvc', 'CashSale']);
const DISCOUNT_ACCOUNT = /discount/i;
const FREIGHT_ACCOUNT = /freight|shipping|delivery|transportation/i;

const cents = (amount: string) => Math.round(Number(amount) * 100) || 0;

/** One summed line's income, split into the columns it belongs in. */
export function splitLine(line: SalesLine): Partial<Record<SalesColumn, number>> {
  const debit = cents(line.debit);
  const credit = cents(line.credit);
  const income = credit - debit;
  if (RETURNS.has(line.tran_type)) return { returns: income };
  if (DISCOUNT_ACCOUNT.test(line.account_name)) return { discounts: income };
  if (FREIGHT_ACCOUNT.test(line.account_name)) return { transportation: income };
  if (SALES.has(line.tran_type)) return { gross: credit, discounts: -debit };
  if (line.tran_type === 'CustPymt') return { discounts: income };
  return { other: income };
}

const zero = (): SalesAmounts => ({ gross: 0, returns: 0, discounts: 0, transportation: 0, other: 0, net: 0 });

function add(into: SalesAmounts, split: Partial<Record<SalesColumn, number>>) {
  for (const column of SALES_COLUMNS) {
    const amount = split[column] ?? 0;
    into[column] += amount;
    into.net += amount;
  }
}

const hasAmounts = (a: SalesAmounts) => SALES_COLUMNS.some((c) => a[c] !== 0);

export function salesReport(lines: SalesLine[]): SalesReport {
  const rows = new Map<string, SalesRow>();
  const states = new Map<string, SalesStateRow>();
  const accounts = new Map<string, SalesAccountRow>();
  const total = zero();

  for (const line of lines) {
    const split = splitLine(line);
    const location = line.location ?? (line.location_id ? `Location ${line.location_id}` : NO_LOCATION);
    const state = stateOf(line.location);
    const klass = line.class ?? (line.class_id ? `Class ${line.class_id}` : NO_CLASS);

    const key = `${state}\u0000${location}\u0000${klass}`;
    if (!rows.has(key)) rows.set(key, { state, location, class: klass, ...zero() });
    add(rows.get(key)!, split);

    if (!states.has(state)) states.set(state, { state, ...zero() });
    add(states.get(state)!, split);

    if (!accounts.has(line.account)) {
      accounts.set(line.account, { account: line.account, number: line.account_number, name: line.account_name, ...zero() });
    }
    add(accounts.get(line.account)!, split);

    add(total, split);
  }

  // States and locations as the audit reads them, a location with none last; classes by name.
  const last = (s: string) => (s === '—' || s === NO_LOCATION || s === NO_CLASS ? 1 : 0);
  const order = (a: string, b: string) => last(a) - last(b) || a.localeCompare(b);
  return {
    rows: [...rows.values()].filter(hasAmounts)
      .sort((a, b) => order(a.state, b.state) || order(a.location, b.location) || order(a.class, b.class)),
    states: [...states.values()].filter(hasAmounts).sort((a, b) => order(a.state, b.state)),
    accounts: [...accounts.values()].filter(hasAmounts)
      .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '') || a.name.localeCompare(b.name)),
    total,
  };
}
