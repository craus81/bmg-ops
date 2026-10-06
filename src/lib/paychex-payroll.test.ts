import { describe, it, expect } from 'vitest';
import {
  parseCsv, parsePaychexPayroll, toAmount, toIsoDate, summarizePeriods, loadedHourlyCost,
  rateWindowStart, splitPaychexName, guessProfile, buildPayrollReport,
  defaultPayrollRole, divisionOf, roleLabel, PAYROLL_ROLES,
} from './paychex-payroll';

// Synthetic rows in the real report's shape: no header, 15 columns, period
// END before START, blank overtime cells. Not real pay.
const row = (name: string, id: string, reg: number, regH: number, ot: string, otH: string, earn: number, ben: string, tax: number, total: number, end: string, start: string, loc: string, pos: string) =>
  `"BMG Fleet Installations LLC","${name}","${id}",${reg},${regH},${ot},${otH},${earn},${ben},${tax},${total},${end},${start},"${loc}","${pos}"`;

const GOOD = [
  row('Doe, Jane Q', '4', 2000, 80, '150', '4', 2150, '50', 160, 2360, '01/11/2026', '12/29/2025', 'Main', 'Installer'),
  row('Smith, Bob', '5', 1600, 80, '', '', 1600, '', 120, 1720, '01/11/2026', '12/29/2025', 'Masterack', 'Installer Assistant'),
  row('Doe, Jane Q', '4', 2000, 80, '', '', 2400, '50', 180, 2630, '01/25/2026', '01/12/2026', 'Main', 'Installer'),
  row('Lee, Ann', '9', 500, 0, '', '', 500, '', 38.25, 538.25, '01/15/2026', '01/15/2026', 'Main', ''),
].join('\r\n') + '\r\n';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded commas, CRLF and a BOM', () => {
    expect(parseCsv('﻿"a, b","say ""hi""",3\r\nx,,z\r\n\r\n')).toEqual([['a, b', 'say "hi"', '3'], ['x', '', 'z']]);
  });
});

describe('toAmount / toIsoDate', () => {
  it('blank is 0, junk is null, parens are negative', () => {
    expect(toAmount('')).toBe(0);
    expect(toAmount('1,234.50')).toBe(1234.5);
    expect(toAmount('(12)')).toBe(-12);
    expect(toAmount('abc')).toBeNull();
  });
  it('accepts real MM/DD/YYYY dates only', () => {
    expect(toIsoDate('01/11/2026')).toBe('2026-01-11');
    expect(toIsoDate('2/30/2026')).toBeNull();
    expect(toIsoDate('2026-01-11')).toBeNull();
  });
});

describe('parsePaychexPayroll', () => {
  it('reads the headerless 15-column report by position', () => {
    const { rows, errors } = parsePaychexPayroll(GOOD);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      employee_name: 'Doe, Jane Q', paychex_employee_id: '4', regular_amount: 2000, regular_hours: 80,
      overtime_amount: 150, overtime_hours: 4, total_earnings: 2150, er_benefits: 50, er_taxes: 160,
      total_labor_cost: 2360, period_start: '2025-12-29', period_end: '2026-01-11', location: 'Main', position: 'Installer',
    });
    expect(rows[1]).toMatchObject({ overtime_amount: 0, overtime_hours: 0, er_benefits: 0 });
  });

  it('skips a header row if Paychex ever sends one', () => {
    const header = '"Company name","Full name","Employee ID","Regular amounts","Regular hours","Overtime amounts","Overtime hours","Total earnings & reimbursements","Total ER benefits costs","Total ER taxes","Total labor cost","Period end date","Period start date","Business location","Position"';
    const { rows, errors } = parsePaychexPayroll(`${header}\n${GOOD}`);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(4);
  });

  it('refuses the whole file when a row has the wrong column count', () => {
    const { errors } = parsePaychexPayroll(GOOD + '"BMG","Short, Row","7",1,2\n');
    expect(errors[0]).toMatch(/Row 5: expected 15 columns, found 5/);
  });

  it('catches reordered columns through the labor-cost identity', () => {
    // ER taxes and total swapped.
    const bad = row('Doe, Jane Q', '4', 2000, 80, '', '', 2000, '', 2160, 160, '01/11/2026', '12/29/2025', 'Main', 'Installer');
    expect(parsePaychexPayroll(bad).errors[0]).toMatch(/doesn't equal total labor cost/);
  });

  it('catches swapped date columns (start after end)', () => {
    const bad = row('Doe, Jane Q', '4', 2000, 80, '', '', 2000, '', 160, 2160, '12/29/2025', '01/11/2026', 'Main', 'Installer');
    expect(parsePaychexPayroll(bad).errors[0]).toMatch(/date columns may be swapped/);
  });

  it('flags non-numbers and bad dates', () => {
    const bad1 = row('Doe, Jane Q', '4', 2000, 80, 'N/A', '', 2000, '', 160, 2160, '01/11/2026', '12/29/2025', 'Main', 'Installer');
    expect(parsePaychexPayroll(bad1).errors[0]).toMatch(/Overtime amounts is not a number/);
    const bad2 = row('Doe, Jane Q', '4', 2000, 80, '', '', 2000, '', 160, 2160, 'Jan 11', '12/29/2025', 'Main', 'Installer');
    expect(parsePaychexPayroll(bad2).errors[0]).toMatch(/aren't MM\/DD\/YYYY/);
  });

  it('an empty file is an error, not an empty import', () => {
    expect(parsePaychexPayroll('').errors).toEqual(['The file is empty.']);
    expect(parsePaychexPayroll('\n\n').errors).toEqual(['The file is empty.']);
  });
});

describe('summarizePeriods', () => {
  it('one line per pay period, oldest first', () => {
    const p = summarizePeriods(parsePaychexPayroll(GOOD).rows);
    expect(p.map(x => `${x.period_start}|${x.period_end}`)).toEqual(['2025-12-29|2026-01-11', '2026-01-15|2026-01-15', '2026-01-12|2026-01-25']);
    expect(p[0]).toMatchObject({ checks: 2, hours: 164, overtime_hours: 4, total_labor_cost: 4080 });
  });
});

describe('loadedHourlyCost', () => {
  it('total labor cost over regular + overtime hours', () => {
    expect(loadedHourlyCost([
      { period_end: '2026-01-11', regular_hours: 80, overtime_hours: 4, total_labor_cost: 2360 },
      { period_end: '2026-01-25', regular_hours: 80, overtime_hours: 0, total_labor_cost: 2630 },
    ])).toEqual({ rate: 30.43, hours: 164, cost: 4990 });
  });
  it('no worked hours → no rate (bonus-only checks)', () => {
    expect(loadedHourlyCost([{ period_end: '2026-01-15', regular_hours: 0, overtime_hours: 0, total_labor_cost: 538.25 }]).rate).toBeNull();
  });
  it('window starts 91 days before the latest period end', () => {
    expect(rateWindowStart('2026-09-20')).toBe('2026-06-21');
  });
});

describe('name matching', () => {
  it('splits "Last, First M"', () => {
    expect(splitPaychexName('Soler Soler, Zidclary')).toEqual({ last: 'soler soler', first: 'zidclary' });
    expect(splitPaychexName('Arie, Brian P')).toEqual({ last: 'arie', first: 'brian' });
  });

  const profiles = [
    { id: 'a', full_name: 'Brian Arie' },
    { id: 'b', full_name: 'Mike Hubbard' },
    { id: 'c', full_name: 'Zidclary Soler' },
    { id: 'd', full_name: 'Craig George' },
    { id: 'e', full_name: 'Zach George' },
    { id: 'f', full_name: 'Emily George' },
  ];

  it('matches last name + first 2 letters of first name, unambiguously', () => {
    expect(guessProfile('Arie, Brian P', profiles)?.id).toBe('a');
    expect(guessProfile('Hubbard, Michael', profiles)?.id).toBe('b');
    expect(guessProfile('Soler Soler, Zidclary', profiles)?.id).toBe('c');
    expect(guessProfile('George, Zachary', profiles)?.id).toBe('e');
    expect(guessProfile('George, Harold', profiles)).toBeNull();
  });

  it('two candidates → no guess', () => {
    expect(guessProfile('George, Craig', [...profiles, { id: 'g', full_name: 'Craig George' }])).toBeNull();
  });
});

describe('buildPayrollReport', () => {
  it('rolls up totals, people, overtime % and loaded rate', () => {
    const r = buildPayrollReport(parsePaychexPayroll(GOOD).rows);
    expect(r.totals).toMatchObject({ people: 3, regular_hours: 240, overtime_hours: 4, total_labor_cost: 7248.25 });
    expect(r.totals.loaded_rate).toBe(29.71);
    expect(r.totals.overtime_pct).toBe(1.6);
    expect(r.byPerson[0]).toMatchObject({ key: '4', label: 'Doe, Jane Q', total_labor_cost: 4990, loaded_rate: 30.43 });
    expect(r.byLocation.map(g => g.label)).toEqual(['Main', 'Masterack']);
    expect(r.byPosition.find(g => g.key === '')?.label).toBe('(no position)');
    expect(r.byMonth.map(g => g.key)).toEqual(['2026-01']);
  });
  it('empty range → zero totals', () => {
    expect(buildPayrollReport([]).totals).toMatchObject({ people: 0, total_labor_cost: 0, loaded_rate: null });
  });
});

describe('payroll roles', () => {
  it('every role rolls up to a division', () => {
    expect(PAYROLL_ROLES.map(r => `${r.key}:${r.division}`)).toEqual([
      'shop_tech:upfit', 'upfit_management:upfit',
      'graphics_production:graphics', 'graphics_installer:graphics', 'graphics_management:graphics',
      'sales:shared', 'office_admin:shared',
    ]);
    expect(divisionOf('bogus')).toBeNull();
    expect(roleLabel(null)).toBe('(no role set)');
  });

  it('suggests a role only from an unambiguous login role', () => {
    expect(defaultPayrollRole(['shop_tech'])).toBe('shop_tech');
    expect(defaultPayrollRole(['production'])).toBe('graphics_production');
    expect(defaultPayrollRole(['sales'])).toBe('sales');
    expect(defaultPayrollRole(['finance'])).toBe('office_admin');
    expect(defaultPayrollRole(['installer'])).toBeNull();
    expect(defaultPayrollRole(['super_admin'])).toBeNull();
  });

  it('splits the report into Upfit / Graphics / Shared, unassigned last', () => {
    const rows = parsePaychexPayroll(GOOD).rows;
    const roles: Record<string, string> = { '4': 'shop_tech', '5': 'graphics_installer' };
    const r = buildPayrollReport(rows.map(c => ({ ...c, role: roles[c.paychex_employee_id] ?? null })));
    expect(r.byDivision.map(g => `${g.label}:${g.total_labor_cost}`)).toEqual(['Upfit:4990', 'Graphics:1720', '(no role set):538.25']);
    expect(r.byRole.map(g => g.label).sort()).toEqual(['(no role set)', 'Graphics Installer', 'Shop Tech']);
    expect(r.byMonthDivision).toEqual([{ month: '2026-01', upfit: 4990, graphics: 1720, shared: 0, unassigned: 538.25 }]);
  });
});
