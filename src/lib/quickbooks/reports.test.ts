import { describe, it, expect } from 'vitest';
import {
  REPORT_MAX_BYTES,
  REPORT_PLAN,
  columnKey,
  materializeReportPlan,
  parseReportLines,
  reportExternalId,
  reportSha256,
  summarizeReport,
} from './reports';
import { makeFakeService, writesTo } from './test-fake-service';

describe('REPORT_PLAN', () => {
  const plan = REPORT_PLAN(2024, 2024);

  it('covers P&L, Balance Sheet and Cash Flow monthly, quarterly and yearly on both bases', () => {
    for (const type of ['ProfitAndLoss', 'BalanceSheet', 'CashFlow']) {
      for (const basis of ['accrual', 'cash']) {
        const rows = plan.filter(p => p.report_type === type && p.basis === basis);
        expect(rows.filter(r => r.period_kind === 'month'), `${type}/${basis}`).toHaveLength(12);
        expect(rows.filter(r => r.period_kind === 'quarter')).toHaveLength(4);
        expect(rows.filter(r => r.period_kind === 'year')).toHaveLength(1);
      }
    }
  });

  it('stores TrialBalance and GeneralLedger at the finest grain ONLY', () => {
    // A month's TB/GL sums to the quarter and the year, so quarterly and
    // yearly copies would be derivable duplicates — and a yearly GL is the
    // biggest payload QuickBooks renders, straight into the 8 MB cap.
    for (const type of ['TrialBalance', 'GeneralLedger']) {
      const rows = plan.filter(p => p.report_type === type);
      expect(rows).toHaveLength(12);
      expect(rows.every(r => r.period_kind === 'month')).toBe(true);
      expect(rows.every(r => r.basis === 'accrual')).toBe(true);
    }
  });

  it('the file states WHY those two are monthly-only', () => {
    const src = require('fs').readFileSync(require('path').join(process.cwd(), 'src/lib/quickbooks/reports.ts'), 'utf8');
    expect(src).toMatch(/finest grain/i);
    expect(src).toMatch(/derivable duplicates/i);
  });

  it('PINS basis / period_kind / period for every as-of report', () => {
    // Left to each builder, two would pick differently ('none' vs 'accrual';
    // Jan 1 vs the as-of date) and a re-run would insert a duplicate instead
    // of upserting the same row.
    const aging = plan.find(p => p.report_type === 'AgedReceivables' && p.period_start === '2024-01-31')!;
    expect(aging.basis).toBe('none');
    expect(aging.period_kind).toBe('as_of');
    expect(aging.period_start).toBe('2024-01-31');
    expect(aging.period_end).toBe('2024-01-31');
    expect(aging.summarize_by).toBe('Total');
    expect(aging.params).toEqual({ report_date: '2024-01-31' });
    expect(reportExternalId(aging)).toBe('AgedReceivables:none:2024-01-31:2024-01-31:Total');
  });

  it('the four yearly as-of lists land on Dec 31', () => {
    for (const type of ['AgedReceivableDetail', 'AgedPayableDetail', 'CustomerBalance', 'VendorBalance']) {
      const rows = plan.filter(p => p.report_type === type);
      expect(rows, type).toHaveLength(1);
      expect(rows[0].period_start).toBe('2024-12-31');
    }
  });

  it('every external_id in a year is unique', () => {
    const ids = plan.map(reportExternalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every period report sends summarize_column_by Total via a params accounting_method', () => {
    const pnl = plan.find(p => p.report_type === 'ProfitAndLoss' && p.basis === 'cash' && p.period_kind === 'year')!;
    expect(pnl.params).toEqual({ start_date: '2024-01-01', end_date: '2024-12-31', accounting_method: 'Cash' });
    expect(pnl.summarize_by).toBe('Total');
  });

  it('spans multiple years', () => {
    expect(REPORT_PLAN(2023, 2024).length).toBe(plan.length * 2);
  });
});

describe('materializeReportPlan', () => {
  it('upserts DIRECTLY with ignoreDuplicates, never through upsertRows', async () => {
    // Its ':'-joined key would be rejected by write.ts's slash guard, and a
    // re-run must not reset a snapshot that is already stored.
    const svc = makeFakeService();
    const plan = REPORT_PLAN(2024, 2024).slice(0, 3);
    const { planned, errors } = await materializeReportPlan(svc as any, plan, 'run-1');
    expect(errors).toEqual([]);
    // `planned`, not `inserted`: ignoreDuplicates means a re-run sends the
    // same batch and lands nothing, and PostgREST does not say which rows it
    // skipped — so the number is the plan size and is named for it.
    expect(planned).toBe(3);
    const [write] = writesTo(svc, 'ledger_report_snapshots');
    expect(write.op).toBe('upsert');
    expect(write.rows[0].status).toBe('pending');
    expect(write.rows[0].source).toBe('quickbooks');
    expect(write.rows[0].import_run_id).toBe('run-1');
  });
});

describe('columnKey — DEFENSIVE parsing, not a probe', () => {
  it("maps Total and TOTAL to 'total'", () => {
    expect(columnKey('Total')).toBe('total');
    expect(columnKey('TOTAL')).toBe('total');
    expect(columnKey('')).toBe('total');
  });

  it('parses Mon YYYY, Qn YYYY and YYYY column titles', () => {
    // Unreachable on today's plan (every report asks for summarize_column_by
    // Total) and settles NO capability — they exist so a future plan parses
    // into real period keys instead of storing a title verbatim.
    expect(columnKey('Jan 2024')).toBe('2024-01');
    expect(columnKey('Dec 2024')).toBe('2024-12');
    expect(columnKey('Q3 2024')).toBe('2024-Q3');
    expect(columnKey('2024')).toBe('2024');
  });

  it('keeps an unrecognised title VERBATIM rather than coercing it', () => {
    // A wrong key would silently merge two different columns.
    expect(columnKey('Broadway Ford')).toBe('Broadway Ford');
    expect(columnKey('Xyz 2024')).toBe('Xyz 2024');
  });
});

const PNL = {
  Header: { Time: '2026-01-02T03:04:05-06:00', ReportName: 'ProfitAndLoss' },
  Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Total' }] },
  Rows: {
    Row: [
      {
        type: 'Section',
        Header: { ColData: [{ value: 'Income' }] },
        Rows: {
          Row: [
            { type: 'Data', ColData: [{ value: 'Upfit sales', id: '77' }, { value: '120000.00' }] },
            { type: 'Data', ColData: [{ value: 'Graphics', id: '78' }, { value: '' }] },
          ],
        },
        Summary: { ColData: [{ value: 'Total Income' }, { value: '120000.00' }] },
      },
      { type: 'Data', group: 'NetIncome', Summary: { ColData: [{ value: 'Net Income' }, { value: '42000.00' }] } },
    ],
  },
};

describe('parseReportLines', () => {
  it('flattens sections, data rows and totals with a joined line_key', () => {
    const lines = parseReportLines(PNL);
    const byKey = Object.fromEntries(lines.map(l => [l.line_key, l]));
    expect(byKey['Income/Upfit sales'].amount).toBe(120000);
    expect(byKey['Income/Upfit sales'].row_type).toBe('data');
    expect(byKey['Income/Upfit sales'].section_path).toBe('Income');
    expect(byKey['Income/Upfit sales'].account_external_id).toBe('Account/77');
    expect(byKey['Income/Total Income#total'].row_type).toBe('section_total');
    expect(byKey['Net Income#total'].row_type).toBe('grand_total');
    expect(lines.every(l => l.column_key === 'total')).toBe(true);
  });

  it('a BLANK cell is NULL, never 0 — QuickBooks printed no value there', () => {
    const line = parseReportLines(PNL).find(l => l.label === 'Graphics')!;
    expect(line.amount).toBeNull();
  });

  it('handles a report with neither Rows nor Columns without throwing', () => {
    expect(parseReportLines({})).toEqual([]);
  });

  it('parses a multi-column report into per-period keys', () => {
    const monthly = {
      Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Jan 2024' }, { ColTitle: 'Feb 2024' }, { ColTitle: 'Total' }] },
      Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Sales' }, { value: '10' }, { value: '20' }, { value: '30' }] }] },
    };
    const lines = parseReportLines(monthly);
    expect(lines.map(l => [l.column_key, l.amount])).toEqual([['2024-01', 10], ['2024-02', 20], ['total', 30]]);
  });
});

describe('summarizeReport', () => {
  it('picks the canonical headline numbers off the total column', () => {
    const summary = summarizeReport(PNL);
    expect(summary['Total Income']).toBe(120000);
    expect(summary['Net Income']).toBe(42000);
  });

  it('a label the report never printed is ABSENT, and a blank one is NULL — never 0', () => {
    const summary = summarizeReport(PNL);
    expect(summary).not.toHaveProperty('Total Assets');
    const withBlank = summarizeReport({
      Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Total' }] },
      Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Gross Profit' }, { value: '' }] }] },
    });
    expect(withBlank['Gross Profit']).toBeNull();
  });
});

describe('reportSha256', () => {
  it('is stable for the same bytes and different for a changed one', () => {
    const a = reportSha256('{"Header":{}}');
    expect(a).toBe(reportSha256('{"Header":{}}'));
    expect(a).not.toBe(reportSha256('{"Header":{} }'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('REPORT_MAX_BYTES', () => {
  it('is the 8 MB cap the importer refuses a payload over', () => {
    expect(REPORT_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});
