import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * QuickBooks reports, stored as QuickBooks rendered them.
 *
 * Owner requirement 2 asks for P&L / Balance Sheet / Cash Flow / GL / Trial
 * Balance / aging "by period (monthly, quarterly, yearly)". The plan below
 * materializes one PENDING `ledger_report_snapshots` row per (report, basis,
 * period, summarize_by) and the importer drains them; `payload_raw` keeps
 * the response byte-exact so a future disagreement with QuickBooks can be
 * settled against what it actually said.
 *
 * This phase WRITES financial rows, so it is deliberately NOT in the
 * gate-free phase set: `--phases reports` without a read dry run and a
 * confirmed cutover answers 412 `needsDryRun`, exactly like a full import.
 */

const REPORT_SOURCE = 'quickbooks';
/** Rows are materialized in batches of this many. */
const PLAN_CHUNK = 500;
/** A payload larger than this is refused rather than stored. */
export const REPORT_MAX_BYTES = 8 * 1024 * 1024;

export interface PlannedReport {
  report_type: string;
  basis: 'accrual' | 'cash' | 'none';
  period_kind: 'month' | 'quarter' | 'year' | 'as_of' | 'custom';
  period_start: string;
  period_end: string;
  summarize_by: string;
  params: Record<string, string>;
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * The unique key. `':'`-joined rather than `'/'`-joined, which is why
 * `ledger_report_snapshots` upserts DIRECTLY instead of through
 * `upsertRows` — that function's slash guard would reject every one of
 * these (src/lib/ledger/write.ts).
 */
export function reportExternalId(p: PlannedReport): string {
  return `${p.report_type}:${p.basis}:${p.period_start}:${p.period_end}:${p.summarize_by}`;
}

/**
 * Every report snapshot we intend to hold, per year.
 *
 * Two deliberate monthly-only plans, and the reason is worth stating: a
 * month's TRIAL BALANCE and GENERAL LEDGER sum to the quarter and the year,
 * so quarterly/yearly copies would be derivable duplicates of the same
 * cells — and a yearly GL is the single biggest payload QuickBooks renders,
 * heading straight for the 8 MB cap.
 *
 * As-of reports (the agings and the balance lists) take no period and no
 * accounting method, so the three NOT NULL columns that ride in the unique
 * key are PINNED here — `basis 'none'`, `period_kind 'as_of'`,
 * `period_start = period_end = report_date`. Left to each builder, two of
 * them would pick differently ('none' vs 'accrual'; Jan 1 vs the as-of
 * date) and a re-run would insert a duplicate instead of upserting the same
 * row.
 */
export function REPORT_PLAN(yearFrom: number, yearTo: number): PlannedReport[] {
  const out: PlannedReport[] = [];
  const bases: ('accrual' | 'cash')[] = ['accrual', 'cash'];

  for (let y = yearFrom; y <= yearTo; y++) {
    const period = (
      report_type: string,
      basis: 'accrual' | 'cash',
      period_kind: 'month' | 'quarter' | 'year',
      start: string,
      end: string,
    ) =>
      out.push({
        report_type,
        basis,
        period_kind,
        period_start: start,
        period_end: end,
        summarize_by: 'Total',
        params: { start_date: start, end_date: end, accounting_method: basis === 'cash' ? 'Cash' : 'Accrual' },
      });

    const asOf = (report_type: string, on: string) =>
      out.push({
        report_type,
        basis: 'none',
        period_kind: 'as_of',
        period_start: on,
        period_end: on,
        summarize_by: 'Total',
        params: { report_date: on },
      });

    for (const basis of bases) {
      for (const type of ['ProfitAndLoss', 'BalanceSheet', 'CashFlow']) {
        // Monthly.
        for (let m = 1; m <= 12; m++) period(type, basis, 'month', ymd(y, m, 1), ymd(y, m, monthEnd(y, m)));
        // Quarterly.
        for (let q = 0; q < 4; q++) {
          const startM = q * 3 + 1;
          const endM = startM + 2;
          period(type, basis, 'quarter', ymd(y, startM, 1), ymd(y, endM, monthEnd(y, endM)));
        }
        // Yearly.
        period(type, basis, 'year', ymd(y, 1, 1), ymd(y, 12, 31));
      }
    }

    // Finest grain only — see the note above.
    for (let m = 1; m <= 12; m++) {
      period('TrialBalance', 'accrual', 'month', ymd(y, m, 1), ymd(y, m, monthEnd(y, m)));
      period('GeneralLedger', 'accrual', 'month', ymd(y, m, 1), ymd(y, m, monthEnd(y, m)));
      asOf('AgedReceivables', ymd(y, m, monthEnd(y, m)));
      asOf('AgedPayables', ymd(y, m, monthEnd(y, m)));
    }

    for (const type of ['AgedReceivableDetail', 'AgedPayableDetail', 'CustomerBalance', 'VendorBalance']) {
      asOf(type, ymd(y, 12, 31));
    }
  }

  return out;
}

/**
 * Materialize the plan as pending rows. `ignoreDuplicates` so a re-run adds
 * only what is new and never resets a snapshot already `stored`.
 *
 * The number returned is `planned`, NOT "inserted": with `ignoreDuplicates`
 * a re-run sends the same batch and lands nothing, and PostgREST does not
 * report which rows it skipped. Naming it after what it actually counts is
 * cheaper — and more honest — than a select-count either side of the write.
 */
export async function materializeReportPlan(
  service: SupabaseClient,
  plan: PlannedReport[],
  runId: string,
): Promise<{ planned: number; errors: string[] }> {
  const errors: string[] = [];
  let planned = 0;
  for (let i = 0; i < plan.length; i += PLAN_CHUNK) {
    const batch = plan.slice(i, i + PLAN_CHUNK).map(p => ({
      source: REPORT_SOURCE,
      external_id: reportExternalId(p),
      report_type: p.report_type,
      basis: p.basis,
      period_kind: p.period_kind,
      period_start: p.period_start,
      period_end: p.period_end,
      summarize_by: p.summarize_by,
      params: p.params,
      status: 'pending',
      import_run_id: runId,
    }));
    const { error } = await service
      .from('ledger_report_snapshots')
      .upsert(batch, { onConflict: 'source,external_id', ignoreDuplicates: true });
    if (error) errors.push(error.message);
    else planned += batch.length;
  }
  return { planned, errors };
}

export interface ReportLine {
  line_key: string;
  label: string;
  section_path: string;
  depth: number;
  row_type: 'data' | 'section_total' | 'grand_total';
  column_key: string;
  amount: number | null;
  account_external_id: string | null;
}

/**
 * Normalize a QuickBooks column title into a stable key.
 *
 * DEFENSIVE PARSING, NOT A PROBE. REPORT_PLAN always sends
 * `summarize_column_by: 'Total'`, so the Month/Quarter/Year branches are
 * unreachable on today's plan and settle no capability — they exist so that
 * a future plan with a different `summarize_column_by` parses into real
 * period keys instead of storing a column title verbatim. `reports.test.ts`
 * covers them as parser cases for the same reason.
 */
export function columnKey(title: string): string {
  const t = String(title || '').trim();
  if (!t) return 'total';
  if (/^total$/i.test(t)) return 'total';
  const month = /^([A-Z][a-z]{2}) (\d{4})$/.exec(t);
  if (month) {
    const idx = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(month[1]);
    if (idx >= 0) return `${month[2]}-${pad(idx + 1)}`;
  }
  const quarter = /^Q([1-4]) (\d{4})$/.exec(t);
  if (quarter) return `${quarter[2]}-Q${quarter[1]}`;
  if (/^\d{4}$/.test(t)) return t;
  // Anything unrecognised is kept VERBATIM rather than coerced — a wrong key
  // would silently merge two different columns in ledger_report_lines.
  return t;
}

function columnKeys(json: any): string[] {
  const cols = json?.Columns?.Column;
  if (!Array.isArray(cols) || cols.length === 0) return ['total'];
  return cols.map((c: any) => columnKey(c?.ColTitle));
}

const amountOf = (v: unknown): number | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Flatten a QuickBooks report into cells.
 *
 * `line_key` is the section path plus the label, so the same line in two
 * periods lands on the same key and a compare view can join them. Totals get
 * a `'#total'` suffix so a section and its total never collide.
 *
 * A blank cell parses to NULL, never 0: QuickBooks prints nothing where a
 * line has no value for that column, and a zero there would show up as a
 * real number on a chart.
 */
export function parseReportLines(json: any): ReportLine[] {
  const keys = columnKeys(json);
  const out: ReportLine[] = [];

  const emit = (
    label: string,
    sectionPath: string[],
    depth: number,
    rowType: ReportLine['row_type'],
    colData: any[],
    keySuffix = '',
  ) => {
    const lineKey = [...sectionPath, label].filter(Boolean).join('/') + keySuffix;
    const accountId = colData?.[0]?.id ? `Account/${colData[0].id}` : null;
    // Column 0 is the label column; values start at 1 when there is more
    // than one column, and at 0 for a single-column ('Total') report.
    const valueStart = keys.length > 1 || (colData || []).length > 1 ? 1 : 0;
    for (let c = valueStart; c < (colData || []).length; c++) {
      const key = keys[c] ?? keys[keys.length - 1] ?? 'total';
      out.push({
        line_key: lineKey,
        label,
        section_path: sectionPath.join('/'),
        depth,
        row_type: rowType,
        column_key: key,
        amount: amountOf(colData[c]?.value),
        account_external_id: accountId,
      });
    }
  };

  const walk = (rows: any[], sectionPath: string[], depth: number, topLevel: boolean) => {
    for (const row of rows || []) {
      const type = String(row?.type || '');
      if (type === 'Section') {
        const header = row?.Header?.ColData?.[0]?.value;
        const nextPath = header ? [...sectionPath, String(header)] : sectionPath;
        if (Array.isArray(row?.Rows?.Row)) walk(row.Rows.Row, nextPath, depth + 1, false);
        if (row?.Summary?.ColData) {
          emit(
            String(row.Summary.ColData[0]?.value || header || 'Total'),
            nextPath,
            depth,
            'section_total',
            row.Summary.ColData,
            '#total',
          );
        }
        continue;
      }
      if (type === 'Data' && row?.ColData) {
        emit(String(row.ColData[0]?.value ?? ''), sectionPath, depth, 'data', row.ColData);
        continue;
      }
      if (row?.Summary?.ColData) {
        // A top-level Summary, or a named group like NetIncome/GrossProfit,
        // is the report's bottom line rather than a section subtotal.
        const grand = topLevel || /^(NetIncome|GrossProfit)$/i.test(String(row?.group || ''));
        emit(
          String(row.Summary.ColData[0]?.value ?? row?.group ?? 'Total'),
          sectionPath,
          depth,
          grand ? 'grand_total' : 'section_total',
          row.Summary.ColData,
          '#total',
        );
      }
    }
  };

  walk(json?.Rows?.Row || [], [], 0, true);
  return out;
}

/** Labels worth pulling out for a compare view / dashboard tile. */
const SUMMARY_LABELS = [
  'Total Income',
  'Total Cost of Goods Sold',
  'Gross Profit',
  'Total Expenses',
  'Net Income',
  'Total Assets',
  'Total Liabilities',
  'Total Equity',
  'Current',
  '1 - 30',
  '31 - 60',
  '61 - 90',
  '91 and over',
  'Total',
];

/**
 * The handful of headline numbers, keyed by canonical label.
 *
 * A label the report did not print is NULL, never 0 — a missing "Gross
 * Profit" means QuickBooks rendered no such line, and printing zero would
 * put a fabricated figure on a financial screen.
 */
export function summarizeReport(json: any): Record<string, number | null> {
  const lines = parseReportLines(json);
  const summary: Record<string, number | null> = {};
  for (const wanted of SUMMARY_LABELS) {
    const hit = lines.find(
      l => l.column_key === 'total' && l.label.trim().toLowerCase() === wanted.toLowerCase(),
    );
    if (hit) summary[wanted] = hit.amount;
  }
  return summary;
}

export function reportSha256(rawText: string): string {
  return crypto.createHash('sha256').update(rawText, 'utf8').digest('hex');
}
