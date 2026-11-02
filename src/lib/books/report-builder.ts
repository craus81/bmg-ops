import { KNOWN_LOCATION_IDS } from '@/lib/invoice-location';
import { monthsBetween, toCents } from './netsuite-gl';
import { NO_PARTY, NONE, type BuilderBy, type BuilderMonths, type BuilderRows } from './report-builder-words';
import { profitAndLossByName, profitAndLossLines, type ReportData, type ReportLine } from './reports';

/**
 * The report builder (Books → Reports → Report builder, docs/books.md
 * "Report builder"; the NetSuite Exit Checklist's "Report builder", thread
 * "Replacing NetSuite with FleetSuite", 2026-10-31): FleetSuite's own profit
 * and loss for any months from January 2025, laid out as Reports lays it out
 * (src/lib/books/reports.ts), with a column for each month, quarter, year,
 * division or location the months have, or one for them altogether, and only
 * one division's or one location's lines when asked. Every column has the
 * same lines, and with more than one a Total column adds them up. Its lines
 * are the accounts, as on Reports, or the customers or vendors on each part
 * of the profit and loss (part 73), and a report can be saved by name
 * (books_saved_reports, migration 501).
 *
 * It reads FleetSuite's journal split by division and location
 * (gl_books_split_totals, migration 500, which says where a line's division
 * and location come from), and for lines by name, by customer or vendor too
 * (gl_books_party_totals, migration 501, which says where a line's customer
 * or vendor comes from), so it shows FleetSuite's side alone. The split,
 * all of it, comes to the profit and loss on Reports for the same months,
 * account by account (`ties`).
 */

/** FleetSuite's journal on one income or expense account in one month, for one division and location (gl_books_split_totals). */
export interface SplitAmount {
  /** The account's NetSuite id, or 'fs:<id>' for one NetSuite doesn't have. */
  account: string;
  /** 'YYYY-MM-01'. */
  month: string;
  division: string | null;
  /** The line's own location key ('ofallon'), when it has one. */
  location: string | null;
  /** For a line without one of its own: NetSuite's location id on the line it copies, or on its document. */
  netsuite_location: string | null;
  debit: string;
  credit: string;
}

/** The split by customer or vendor too, for one kind of name, in the months a report covers (gl_books_party_totals). */
export interface PartyAmount extends SplitAmount {
  /** NetSuite's id for the customer or vendor; null for a line with none. */
  party: string | null;
}

/** A report's lines by name: the split by customer or vendor, and NetSuite's names for them by id. */
export interface Parties {
  rows: PartyAmount[];
  names: ReadonlyMap<string, string>;
}

/** What a report is asked for. */
export interface BuilderAsk {
  /** What it has a line for. */
  rows: BuilderRows;
  /** How its months were picked: by hand, or moving with the calendar (and worked out into `from` and `to`). */
  months: BuilderMonths;
  /** 'YYYY-MM-01': the months from `from` through `to`. */
  from: string;
  to: string;
  by: BuilderBy;
  /** Only this division's lines ('none' for lines with none); every division's when null. */
  division: string | null;
  /** Only this location's lines ('none' for lines with none); every location's when null. */
  location: string | null;
}

/** A column, or a choice in a filter: its key and what it's called. */
export interface BuilderChoice {
  key: string;
  label: string;
}

export interface BuilderLine {
  kind: ReportLine['kind'];
  depth: number;
  label: string;
  number?: string | null;
  /** An account's key: its NetSuite id, or 'fs:<id>'. */
  account?: string;
  /** A customer's or vendor's key, on lines by name: NetSuite's id, or 'none'. */
  party?: string;
  /** A total over sections: gross profit, net income and the like. */
  grand?: true;
  /** False for an account the chart doesn't have, listed apart at the end. */
  inChart?: boolean;
  /** One amount for each column, as the profit and loss shows them: income and expenses positive. Null on a section or heading. */
  amounts: number[] | null;
}

export interface BuiltReport {
  /** What the lines are: accounts, or customers or vendors. */
  rows: BuilderRows;
  /** The columns in order, the Total last when there's more than one other. */
  columns: BuilderChoice[];
  lines: BuilderLine[];
  /** The divisions and locations the company's journal has, to pick one of. */
  divisions: BuilderChoice[];
  locations: BuilderChoice[];
  /** The division and location picked, when the company's journal has them; else null, every one. */
  division: string | null;
  location: string | null;
  /** Whether the split, all of it, comes to the profit and loss on Reports for the months, account by account. */
  ties: boolean;
}

const TOTAL = 'total';

/** The divisions in the order the builder shows them; a line with none is "Not split". */
const DIVISIONS: ReadonlyArray<[string, string]> = [['upfit', 'Upfit'], ['graphics', 'Graphics'], ['shared', 'Shared'], [NONE, 'Not split']];

const KNOWN_IDS = new Map(Object.entries(KNOWN_LOCATION_IDS));
const collator = new Intl.Collator('en', { numeric: true });
const net = (r: { debit: string; credit: string }) => toCents(r.debit) - toCents(r.credit);

const divisionOf = (r: SplitAmount) => r.division ?? NONE;

/**
 * A line's location: its own key, as NetSuite's id for the location where
 * FleetSuite knows it (src/lib/invoice-location.ts) so it joins NetSuite's
 * lines there; else NetSuite's location on its document; else none.
 */
function locationOf(r: SplitAmount): string {
  if (r.location) return KNOWN_IDS.get(r.location) ?? `own:${r.location}`;
  return r.netsuite_location ?? NONE;
}

/** NetSuite's locations by id, then any FleetSuite key NetSuite has no id for, then none. */
const locationRank = (key: string) => (key === NONE ? 2 : key.startsWith('own:') ? 1 : 0);

/** A location's name: NetSuite's, from the copy of its lists (`names`, by id). */
function locationLabel(key: string, names: ReadonlyMap<string, string>): string {
  if (key === NONE) return 'No location';
  if (key.startsWith('own:')) return `Location ${key.slice(4)}`;
  return names.get(key) ?? `Location ${key}`;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortMonth = (month: string) => SHORT_MONTHS[Number(month.slice(5, 7)) - 1];
const quarterOf = (month: string) => `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`;
const yearOf = (month: string) => month.slice(0, 4);

/**
 * A column for each month, quarter or year the months touch. A quarter or
 * year the months cover only part of says which of its months it has:
 * "Q1 2026 (Feb–Mar)".
 */
function periodColumns(by: 'month' | 'quarter' | 'year', months: string[]): BuilderChoice[] {
  if (by === 'month') return months.map((m) => ({ key: m, label: `${shortMonth(m)} ${yearOf(m)}` }));
  const keyOf = by === 'quarter' ? quarterOf : yearOf;
  const groups = new Map<string, string[]>();
  for (const m of months) groups.set(keyOf(m), [...(groups.get(keyOf(m)) ?? []), m]);
  return [...groups].map(([key, list]) => {
    const name = by === 'quarter' ? `Q${key.slice(-1)} ${key.slice(0, 4)}` : key;
    if (list.length === (by === 'quarter' ? 3 : 12)) return { key, label: name };
    const first = shortMonth(list[0]);
    const last = shortMonth(list[list.length - 1]);
    return { key, label: `${name} (${list.length === 1 ? first : `${first}–${last}`})` };
  });
}

/** The column a line of the split adds to. */
const COLUMN_OF: Record<BuilderBy, (r: SplitAmount) => string> = {
  total: () => TOTAL,
  month: (r) => r.month,
  quarter: (r) => quarterOf(r.month),
  year: (r) => yearOf(r.month),
  division: divisionOf,
  location: locationOf,
};

const addTo = (map: Map<string, number>, key: string, cents: number) => map.set(key, (map.get(key) ?? 0) + cents);

/** What a line by name adds to: its customer or vendor ('none' for none) and its account. */
const nameKey = (r: PartyAmount) => `${r.party ?? NONE}|${r.account}`;

/** The account lines of a report: each column laid out as Reports lays out the profit and loss, from what each account moved. */
function accountLines(data: ReportData, moved: Array<Map<string, number>>): ReportLine[][] {
  // Every column shows each account that has something in any of them.
  const shows = new Set(moved.flatMap((m) => [...m].filter(([, cents]) => cents !== 0).map(([key]) => key)));
  return moved.map((m) => profitAndLossLines(data, (key) => m.get(key) ?? 0, shows));
}

/**
 * The lines by name of a report (`kind`: customer or vendor): each column
 * laid out as the profit and loss, a line in each part for each name with
 * something in any column there, the biggest first as the last column has
 * them, then by name, the one for lines with none last. `moved` is what
 * each name moved on each account in each column (nameKey); `names`
 * NetSuite's names by id.
 */
function nameLines(data: ReportData, moved: Array<Map<string, number>>, kind: Exclude<BuilderRows, 'account'>, names: ReadonlyMap<string, string>): ReportLine[][] {
  const typeOf = new Map(data.accounts.map((a) => [a.netsuite_account_id ?? `fs:${a.id}`, a.account_type]));
  const labelOf = (key: string) => (key === NONE ? NO_PARTY[kind] : names.get(key) ?? `${kind === 'customer' ? 'Customer' : 'Vendor'} ${key}`);
  // Each column's amounts by account type ('' for an account the chart doesn't have), then by name.
  const byType = moved.map((m) => {
    const types = new Map<string, Map<string, number>>();
    for (const [key, cents] of m) {
      const at = key.indexOf('|');
      const type = typeOf.get(key.slice(at + 1)) ?? '';
      types.set(type, addTo(types.get(type) ?? new Map(), key.slice(0, at), cents));
    }
    return types;
  });
  const amountOf = (column: number, types: readonly string[], key: string) =>
    types.reduce((sum, type) => sum + (byType[column].get(type)?.get(key) ?? 0), 0);
  const last = moved.length - 1;
  const shown = new Map<string, string[]>();
  const order = (types: readonly string[], sign: number) => {
    const keys = [...new Set(moved.flatMap((_, c) => types.flatMap((type) => [...(byType[c].get(type)?.keys() ?? [])])))]
      .filter((key) => moved.some((_, c) => amountOf(c, types, key) !== 0))
      .sort((x, y) => Number(x === NONE) - Number(y === NONE)
        || sign * (amountOf(last, types, y) - amountOf(last, types, x))
        || collator.compare(labelOf(x), labelOf(y)));
    shown.set(types.join(), keys);
    return keys;
  };
  const listed = (column: number, types: readonly string[], sign: number) =>
    (shown.get(types.join()) ?? order(types, sign)).map((key) => ({ key, label: labelOf(key), cents: amountOf(column, types, key) }));
  return moved.map((_, column) => profitAndLossByName((types, sign) => listed(column, types, sign), listed(column, [''], 1)));
}

/**
 * One report: the profit and loss for the months asked for, a column for
 * each of what `ask.by` names (and a Total), only the lines of the
 * division and location asked for, a line for each account, or for each
 * customer or vendor when asked and `parties` has them. `split` is the
 * company's journal split by division and location; `names` NetSuite's
 * location names by id.
 */
export function buildReport(
  data: ReportData, split: SplitAmount[], names: ReadonlyMap<string, string>, ask: BuilderAsk, parties: Parties | null = null,
): BuiltReport {
  const divisions = DIVISIONS.filter(([key]) => split.some((r) => divisionOf(r) === key)).map(([key, label]) => ({ key, label }));
  const locations = [...new Set(split.map(locationOf))]
    .sort((x, y) => locationRank(x) - locationRank(y) || collator.compare(x, y))
    .map((key) => ({ key, label: locationLabel(key, names) }));
  const division = divisions.some((d) => d.key === ask.division) ? ask.division : null;
  const location = locations.some((l) => l.key === ask.location) ? ask.location : null;

  const rows = parties ? ask.rows : 'account';
  const inMonths = (r: { month?: string }) => !!r.month && r.month >= ask.from && r.month <= ask.to;
  const kept = (rows === 'account' ? split : parties!.rows).filter((r) => inMonths(r)
    && (division === null || divisionOf(r) === division)
    && (location === null || locationOf(r) === location));

  // Every month, quarter or year the months touch has a column; a division or location, only one the report has lines for.
  const own: BuilderChoice[] = ask.by === 'total' ? []
    : ask.by === 'division' ? divisions.filter((d) => kept.some((r) => divisionOf(r) === d.key))
    : ask.by === 'location' ? locations.filter((l) => kept.some((r) => locationOf(r) === l.key))
    : periodColumns(ask.by, monthsBetween(ask.from, ask.to));
  const columns = own.length === 1 ? own : [...own, { key: TOTAL, label: 'Total' }];

  // What each account, or each name on each account, moved in each column, debit positive.
  const index = new Map(columns.map((c, i) => [c.key, i]));
  const totalAt = index.get(TOTAL);
  const moved = columns.map(() => new Map<string, number>());
  const keyOf = rows === 'account' ? (r: SplitAmount) => r.account : nameKey;
  for (const r of kept) {
    const at = index.get(COLUMN_OF[ask.by](r));
    if (at !== undefined && at !== totalAt) addTo(moved[at], keyOf(r as PartyAmount), net(r));
    if (totalAt !== undefined) addTo(moved[totalAt], keyOf(r as PartyAmount), net(r));
  }

  const laid = rows === 'account' ? accountLines(data, moved) : nameLines(data, moved, rows, parties!.names);
  const lines: BuilderLine[] = laid[0].map((l, i) => ({
    kind: l.kind,
    depth: l.depth,
    label: l.label,
    ...(l.number !== undefined ? { number: l.number } : {}),
    ...(l.account ? { account: l.account } : {}),
    ...(l.party ? { party: l.party } : {}),
    ...(l.grand ? { grand: true as const } : {}),
    ...(l.inChart === false ? { inChart: false } : {}),
    amounts: l.fleetsuite === null ? null : laid.map((c) => c[i].fleetsuite ?? 0),
  }));

  // Reports' profit and loss for the months, FleetSuite's side: its journal on each income and expense account.
  const statement = new Set(data.accounts.filter((a) => a.statement === 'income_statement').map((a) => a.netsuite_account_id ?? `fs:${a.id}`));
  const reported = new Map<string, number>();
  for (const r of data.fleetsuite) if (inMonths(r) && statement.has(r.account)) addTo(reported, r.account, net(r));
  // The split, and the split by name when it's read too: each was read apart from Reports' totals.
  const ties = [split, ...(parties ? [parties.rows] : [])].every((read) => {
    const sums = new Map<string, number>();
    for (const r of read) if (inMonths(r)) addTo(sums, r.account, net(r));
    return [...new Set([...reported.keys(), ...sums.keys()])].every((key) => (reported.get(key) ?? 0) === (sums.get(key) ?? 0));
  });

  return { rows, columns, lines, divisions, locations, division, location, ties };
}
