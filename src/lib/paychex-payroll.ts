/**
 * Paychex Flex payroll import (owner ask 2026-10-06, migration 340).
 *
 * Source: Paychex Flex's scheduled "Payroll Labor Cost" custom report,
 * downloaded each payroll as CSV. Paychex will not put a header row on it,
 * so columns are read BY POSITION, in the order the report is set up:
 *
 *   0 Company name            5 Overtime amounts        10 Total labor cost
 *   1 Full name ("Last, F M") 6 Overtime hours          11 Period end date
 *   2 Employee ID             7 Total earnings & reimb. 12 Period start date
 *   3 Regular amounts         8 Total ER benefits costs 13 Business location
 *   4 Regular hours           9 Total ER taxes          14 Position
 *
 * Reading by position is only safe because every row is checked: exactly 15
 * columns, real MM/DD/YYYY dates with start ≤ end, numeric money/hours, and
 * earnings + ER benefits + ER taxes = total labor cost (Paychex's own
 * identity — it holds on every row of the real file). A reordered report
 * breaks that math or the dates, and the WHOLE file is refused: a payroll
 * table half-loaded from shuffled columns is worse than none.
 */

export const PAYCHEX_COLUMNS = [
  'Company name', 'Full name', 'Employee ID', 'Regular amounts', 'Regular hours',
  'Overtime amounts', 'Overtime hours', 'Total earnings & reimbursements',
  'Total ER benefits costs', 'Total ER taxes', 'Total labor cost',
  'Period end date', 'Period start date', 'Business location', 'Position',
] as const;

export interface PayrollCheckRow {
  company_name: string;
  employee_name: string;
  paychex_employee_id: string;
  regular_amount: number;
  regular_hours: number;
  overtime_amount: number;
  overtime_hours: number;
  total_earnings: number;
  er_benefits: number;
  er_taxes: number;
  total_labor_cost: number;
  period_start: string; // YYYY-MM-DD
  period_end: string;   // YYYY-MM-DD
  location: string;
  position: string;
}

export interface ParseResult {
  rows: PayrollCheckRow[];
  /** Row-level problems ("Row 12: …"). Any error means import nothing. */
  errors: string[];
}

/** RFC-4180-ish CSV: quoted fields, doubled quotes, CRLF, trailing blank lines. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      out.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); out.push(row); }
  return out.filter(r => r.some(c => c.trim() !== ''));
}

/** Blank → 0 (Paychex leaves no-overtime cells empty); junk → null. */
export function toAmount(raw: string): number | null {
  const s = raw.trim().replace(/[$,]/g, '');
  if (s === '') return 0;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(neg ? s.slice(1, -1) : s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** MM/DD/YYYY → YYYY-MM-DD, or null when it is not a real calendar date. */
export function toIsoDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A header row, if Paychex ever starts sending one, is skipped — not an error. */
function isHeaderRow(cells: string[]): boolean {
  return /employee/i.test(cells[2] || '') || (/name/i.test(cells[1] || '') && toAmount(cells[3] || 'x') === null);
}

export function parsePaychexPayroll(text: string): ParseResult {
  const errors: string[] = [];
  const rows: PayrollCheckRow[] = [];
  const table = parseCsv(text);
  if (table.length === 0) return { rows, errors: ['The file is empty.'] };

  table.forEach((cells, idx) => {
    const line = idx + 1;
    if (idx === 0 && isHeaderRow(cells)) return;
    if (cells.length !== PAYCHEX_COLUMNS.length) {
      errors.push(`Row ${line}: expected ${PAYCHEX_COLUMNS.length} columns, found ${cells.length}. Check the report still has the 15 columns in the set order.`);
      return;
    }
    const name = cells[1].trim();
    const empId = cells[2].trim();
    if (!name || !empId) { errors.push(`Row ${line}: missing employee name or ID.`); return; }

    const nums = [3, 4, 5, 6, 7, 8, 9, 10].map(i => toAmount(cells[i]));
    const badNum = nums.findIndex(n => n === null);
    if (badNum !== -1) {
      errors.push(`Row ${line} (${name}): "${cells[badNum + 3]}" in ${PAYCHEX_COLUMNS[badNum + 3]} is not a number.`);
      return;
    }
    const [regAmt, regHrs, otAmt, otHrs, earnings, benefits, taxes, total] = nums as number[];

    const end = toIsoDate(cells[11]);
    const start = toIsoDate(cells[12]);
    if (!start || !end) {
      errors.push(`Row ${line} (${name}): period dates "${cells[12]}" – "${cells[11]}" aren't MM/DD/YYYY dates.`);
      return;
    }
    if (start > end) {
      errors.push(`Row ${line} (${name}): period starts ${cells[12]} after it ends ${cells[11]} — the date columns may be swapped.`);
      return;
    }
    if (Math.abs(earnings + benefits + taxes - total) > 0.05) {
      errors.push(`Row ${line} (${name}): earnings + ER benefits + ER taxes (${round2(earnings + benefits + taxes)}) doesn't equal total labor cost (${total}) — the columns may be out of order.`);
      return;
    }

    rows.push({
      company_name: cells[0].trim(),
      employee_name: name,
      paychex_employee_id: empId,
      regular_amount: round2(regAmt),
      regular_hours: round2(regHrs),
      overtime_amount: round2(otAmt),
      overtime_hours: round2(otHrs),
      total_earnings: round2(earnings),
      er_benefits: round2(benefits),
      er_taxes: round2(taxes),
      total_labor_cost: round2(total),
      period_start: start,
      period_end: end,
      location: cells[13].trim(),
      position: cells[14].trim(),
    });
  });

  if (errors.length === 0 && rows.length === 0) errors.push('No payroll rows found in the file.');
  return { rows, errors };
}

export interface PeriodSummary {
  period_start: string;
  period_end: string;
  checks: number;
  hours: number;
  overtime_hours: number;
  total_labor_cost: number;
}

/** One line per pay period, oldest first — the import preview. */
export function summarizePeriods(rows: Pick<PayrollCheckRow, 'period_start' | 'period_end' | 'regular_hours' | 'overtime_hours' | 'total_labor_cost'>[]): PeriodSummary[] {
  const map = new Map<string, PeriodSummary>();
  for (const r of rows) {
    const key = `${r.period_start}|${r.period_end}`;
    const p = map.get(key) || { period_start: r.period_start, period_end: r.period_end, checks: 0, hours: 0, overtime_hours: 0, total_labor_cost: 0 };
    p.checks++;
    p.hours += Number(r.regular_hours) + Number(r.overtime_hours);
    p.overtime_hours += Number(r.overtime_hours);
    p.total_labor_cost += Number(r.total_labor_cost);
    map.set(key, p);
  }
  return [...map.values()]
    .map(p => ({ ...p, hours: round2(p.hours), overtime_hours: round2(p.overtime_hours), total_labor_cost: round2(p.total_labor_cost) }))
    .sort((a, b) => (a.period_end.localeCompare(b.period_end) || a.period_start.localeCompare(b.period_start)));
}

/** Days of paychecks a cost-per-hour rate averages over (owner default: ~3 months). */
export const RATE_WINDOW_DAYS = 91;

type RateInput = Pick<PayrollCheckRow, 'period_end' | 'regular_hours' | 'overtime_hours' | 'total_labor_cost'>;

/** The window's first period_end (inclusive): RATE_WINDOW_DAYS before the latest. */
export function rateWindowStart(latestPeriodEnd: string, days = RATE_WINDOW_DAYS): string {
  const d = new Date(`${latestPeriodEnd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Loaded cost per WORKED hour: total labor cost ÷ (regular + overtime hours).
 * PTO, holiday and bonus pay carry no worked hours in this report, so they
 * spread across the hours actually worked — which is what a job pays for.
 * Null when there are no worked hours (nothing to divide by).
 */
export function loadedHourlyCost(checks: RateInput[]): { rate: number | null; hours: number; cost: number } {
  let hours = 0, cost = 0;
  for (const c of checks) {
    hours += Number(c.regular_hours) + Number(c.overtime_hours);
    cost += Number(c.total_labor_cost);
  }
  return { rate: hours > 0 ? round2(cost / hours) : null, hours: round2(hours), cost: round2(cost) };
}

/** Lowercase letters only — "Soler Soler, Zidclary" and "zidclary soler" compare. */
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/** "Arie, Brian P" → { first: 'brian', last: 'arie' }. */
export function splitPaychexName(name: string): { first: string; last: string } {
  const [lastRaw, restRaw = ''] = name.split(',');
  return { last: norm(lastRaw), first: norm(restRaw).split(' ')[0] || '' };
}

/**
 * Best-guess FleetSuite person for a Paychex employee: same last name and the
 * first names agree on their first 2 letters (Mike/Michael, Zach/Zachary).
 * Only an UNAMBIGUOUS hit is returned — two candidates means a person picks.
 */
export function guessProfile<T extends { id: string; full_name: string | null }>(paychexName: string, profiles: T[]): T | null {
  const { first, last } = splitPaychexName(paychexName);
  if (!last) return null;
  const hits = profiles.filter(p => {
    const parts = norm(p.full_name || '').split(' ').filter(Boolean);
    if (parts.length < 2) return false;
    const pFirst = parts[0];
    const pLastJoined = parts.slice(1).join(' ');
    const lastOk = pLastJoined === last || parts[parts.length - 1] === last.split(' ').pop();
    const firstOk = !!first && pFirst.slice(0, 2) === first.slice(0, 2);
    return lastOk && firstOk;
  });
  return hits.length === 1 ? hits[0] : null;
}

// ── Report ────────────────────────────────────────────────────────────────

export interface StoredCheck extends PayrollCheckRow {
  id?: string;
}

export interface PayrollGroup {
  key: string;
  label: string;
  people: number;
  regular_hours: number;
  overtime_hours: number;
  regular_amount: number;
  overtime_amount: number;
  total_earnings: number;
  er_benefits: number;
  er_taxes: number;
  total_labor_cost: number;
  /** total labor cost ÷ worked hours; null with no worked hours. */
  loaded_rate: number | null;
  /** overtime hours ÷ worked hours, %. */
  overtime_pct: number | null;
}

function groupBy(checks: StoredCheck[], keyOf: (c: StoredCheck) => string, labelOf: (c: StoredCheck) => string): PayrollGroup[] {
  const map = new Map<string, PayrollGroup & { ids: Set<string> }>();
  for (const c of checks) {
    const key = keyOf(c);
    const g = map.get(key) || {
      key, label: labelOf(c), people: 0, regular_hours: 0, overtime_hours: 0, regular_amount: 0, overtime_amount: 0,
      total_earnings: 0, er_benefits: 0, er_taxes: 0, total_labor_cost: 0, loaded_rate: null, overtime_pct: null, ids: new Set<string>(),
    };
    g.ids.add(c.paychex_employee_id);
    g.regular_hours += Number(c.regular_hours);
    g.overtime_hours += Number(c.overtime_hours);
    g.regular_amount += Number(c.regular_amount);
    g.overtime_amount += Number(c.overtime_amount);
    g.total_earnings += Number(c.total_earnings);
    g.er_benefits += Number(c.er_benefits);
    g.er_taxes += Number(c.er_taxes);
    g.total_labor_cost += Number(c.total_labor_cost);
    map.set(key, g);
  }
  return [...map.values()].map(({ ids, ...g }) => {
    const worked = g.regular_hours + g.overtime_hours;
    return {
      ...g,
      people: ids.size,
      regular_hours: round2(g.regular_hours),
      overtime_hours: round2(g.overtime_hours),
      regular_amount: round2(g.regular_amount),
      overtime_amount: round2(g.overtime_amount),
      total_earnings: round2(g.total_earnings),
      er_benefits: round2(g.er_benefits),
      er_taxes: round2(g.er_taxes),
      total_labor_cost: round2(g.total_labor_cost),
      loaded_rate: worked > 0 ? round2(g.total_labor_cost / worked) : null,
      overtime_pct: worked > 0 ? Math.round((g.overtime_hours / worked) * 1000) / 10 : null,
    };
  }).sort((a, b) => b.total_labor_cost - a.total_labor_cost);
}

export interface PayrollReport {
  totals: PayrollGroup;
  byPerson: PayrollGroup[];   // key = Paychex employee ID
  byLocation: PayrollGroup[];
  byPosition: PayrollGroup[];
  byPeriod: PayrollGroup[];   // key = "start|end", oldest first
  byMonth: PayrollGroup[];    // key = YYYY-MM of period_end, oldest first
}

/** Every rollup the report page shows, from the checks in range. */
export function buildPayrollReport(checks: StoredCheck[]): PayrollReport {
  const totals = groupBy(checks, () => 'all', () => 'All')[0] ?? {
    key: 'all', label: 'All', people: 0, regular_hours: 0, overtime_hours: 0, regular_amount: 0, overtime_amount: 0,
    total_earnings: 0, er_benefits: 0, er_taxes: 0, total_labor_cost: 0, loaded_rate: null, overtime_pct: null,
  };
  return {
    totals,
    byPerson: groupBy(checks, c => c.paychex_employee_id, c => c.employee_name),
    byLocation: groupBy(checks, c => c.location || '', c => c.location || '(no location)'),
    byPosition: groupBy(checks, c => c.position || '', c => c.position || '(no position)'),
    byPeriod: groupBy(checks, c => `${c.period_start}|${c.period_end}`, c => `${c.period_start} – ${c.period_end}`)
      .sort((a, b) => a.key.localeCompare(b.key)),
    byMonth: groupBy(checks, c => c.period_end.slice(0, 7), c => c.period_end.slice(0, 7))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}
