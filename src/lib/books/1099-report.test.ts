// NetSuite's 1099 report next to FleetSuite's (src/lib/books/1099-report.ts):
// reading a made-up export, never keeping a tax ID, checking what the route is
// sent, and holding a report against a made-up year vendor by vendor.
import { describe, it, expect } from 'vitest';
import {
  boxKey, checkReport, compare1099, hasNineDigits, nameKey, read1099Report, read1099ReportFile, readMoney, scrub,
  titleYears, type Report1099,
} from './1099-report';
import type { Payee1099, Year1099 } from './1099s';
import { parseDelimited } from '@/lib/import-installs-parse';

const BOXES = ['Nonemployee Compensation', 'Rents'];

// A made-up export the way NetSuite prints one: its title, then the headings, a row a vendor, and a total.
const EXPORT = [
  '"Sample Fleet Co"',
  '"1099-MISC Summary"',
  '"January 2025 - December 2025"',
  '',
  '"Vendor","Tax ID","Address","Box 1 Rents","Nonemployee Compensation (1099-NEC)","Total"',
  '"V-50 Sample Painting","12-3456789","100 Main St, Springfield MO 65800-1234","","$1,500.00","$1,500.00"',
  '"Example Rentals","123-45-6789","200 Oak Ave","2,400.00","0.00","2,400.00"',
  '"Total","","","2,400.00","1,500.00","3,900.00"',
].join('\n');

const cells = (csv: string) => parseDelimited(csv, ',');

describe('reading the report', () => {
  it('reads each vendor by box and the total, and leaves out the tax IDs and addresses', () => {
    const { report, problems } = read1099Report(cells(EXPORT), BOXES);
    expect(problems).toEqual([]);
    expect(report).toEqual({
      title: ['Sample Fleet Co', '1099-MISC Summary', 'January 2025 - December 2025'],
      columns: [
        { key: 'c1', header: 'Box 1 Rents', box: 'Rents' },
        { key: 'c2', header: 'Nonemployee Compensation (1099-NEC)', box: 'Nonemployee Compensation' },
        { key: 'c3', header: 'Total', box: null },
      ],
      leftOut: ['Tax ID', 'Address'],
      vendors: [
        { label: 'V-50 Sample Painting', names: [], amounts: { c2: 150000, c3: 150000 } },
        { label: 'Example Rentals', names: [], amounts: { c1: 240000, c3: 240000 } },
      ],
      skipped: { totals: 1, noName: 0, combined: 0 },
    });
    const kept = JSON.stringify(report);
    for (const id of ['3456789', '6789', 'Main St', 'Oak Ave']) expect(kept).not.toContain(id);
  });

  it('finds the headings under any title, in any order, with other names kept and named the way NetSuite might', () => {
    const { report } = read1099Report(cells([
      'Report,1099 vendors',
      'Rents,Name,Legal Name,1099-NEC Box 1 - Non-Employee Compensation,Other,Phone',
      '"(1,000.00)",Demo Signs,Demo Signs LLC,500,7,555-0100',
      '-5,Sample Rentals,,,,',
    ].join('\n')), BOXES);
    expect(report?.title).toEqual(['Report · 1099 vendors']);
    expect(report?.columns).toEqual([
      { key: 'c1', header: 'Rents', box: 'Rents' },
      { key: 'c2', header: '1099-NEC Box 1 - Non-Employee Compensation', box: 'Nonemployee Compensation' },
    ]);
    expect(report?.leftOut).toEqual(['Other', 'Phone']);
    expect(report?.vendors).toEqual([
      { label: 'Demo Signs', names: ['Demo Signs LLC'], amounts: { c1: -100000, c2: 50000 } },
      { label: 'Sample Rentals', names: [], amounts: { c1: -500 } },
    ]);
  });

  it("reads a box FleetSuite has no account for, by the form's own name, and takes FleetSuite's spelling first", () => {
    const { report } = read1099Report(cells('Vendor,Royalties,rents\nA,1,2'), ['RENTS']);
    expect(report?.columns.map((c) => c.box)).toEqual(['Royalties', 'RENTS']);
  });

  it("keeps a vendor's other names once each, from every row it's on, and not when they're its name again", () => {
    const { report } = read1099Report(cells([
      'Vendor,Legal Name,Print on Check As,Rents',
      'Demo Signs,DEMO SIGNS,Demo Signs LLC,1',
      'Sample Co,Sample LLC,Sample LLC,2',
      'Sample Co,Sample Holdings,,3',
    ].join('\n')), BOXES);
    expect(report?.vendors).toEqual([
      { label: 'Demo Signs', names: ['Demo Signs LLC'], amounts: { c1: 100 } },
      { label: 'Sample Co', names: ['Sample LLC', 'Sample Holdings'], amounts: { c1: 500 } },
    ]);
  });

  it('reads the headings under a row of headings naming no vendor, and leaves the empty cells out of the title', () => {
    const { report } = read1099Report(cells('"1099-MISC Summary",,\n,Amount,\nVendor,Rents,Nonemployee Compensation\nA,1,2'), BOXES);
    expect(report?.title).toEqual(['1099-MISC Summary', 'Amount']);
    expect(report?.columns.map((c) => c.box)).toEqual(['Rents', 'Nonemployee Compensation']);
    expect(report?.vendors).toEqual([{ label: 'A', names: [], amounts: { c1: 100, c2: 200 } }]);
  });

  it('adds up a vendor listed again, and drops an amount that comes to nothing', () => {
    const { report } = read1099Report(cells('Vendor,Rents,Total\nSample Co,100,100\nSAMPLE CO.,-100,50\nOther Co,1,1'), BOXES);
    expect(report?.vendors).toEqual([
      { label: 'Sample Co', names: [], amounts: { c2: 15000 } },
      { label: 'Other Co', names: [], amounts: { c1: 100, c2: 100 } },
    ]);
    expect(report?.skipped).toEqual({ totals: 0, noName: 0, combined: 1 });
  });

  it('skips total rows and rows of amounts with no vendor, and a row with no amount at all is no vendor', () => {
    const { report } = read1099Report(cells([
      'Vendor,Rents',
      'Sample Co,10',
      ',5',
      '123-45-6789,4',
      'Total - Sample Co,10',
      'Grand Total,15',
      'Totals,15',
      'Total Signs,3',
      'Report run by someone,',
    ].join('\n')), BOXES);
    expect(report?.vendors.map((v) => v.label)).toEqual(['Sample Co', 'Total Signs']);
    expect(report?.skipped).toEqual({ totals: 3, noName: 2, combined: 0 });
  });

  it("says which cells aren't amounts, by row, and keeps nothing", () => {
    const rows = ['Vendor,Rents', 'A,abc', 'B,12-3456789', ...Array.from({ length: 12 }, (_, i) => `C${i},x`)];
    const { report, problems } = read1099Report(cells(rows.join('\n')), BOXES);
    expect(report).toBeNull();
    expect(problems[0]).toBe('Row 2: "abc" under Rents isn\'t an amount.');
    expect(problems[1]).toBe('Row 3: "***" under Rents isn\'t an amount.');
    expect(problems).toHaveLength(11);
    expect(problems[10]).toBe('And 4 more cells that aren\'t amounts.');
    // More than a hundred billion dollars is no amount of a 1099 report.
    expect(read1099Report(cells('Vendor,Rents\nA,"100,000,000,000.00"\nB,"-100,000,000,000.01"'), BOXES).problems)
      .toEqual(['Row 3: "-***" under Rents isn\'t an amount.']);
  });

  it("says when it can't find the headings, or there's nothing under them", () => {
    expect(read1099Report(cells('Name,Address\nA,B'), BOXES).problems[0]).toMatch(/Couldn't find the report's headings/);
    expect(read1099Report(cells('Vendor,Rents\n,'), BOXES)).toEqual({ report: null, problems: ['The report lists no vendors under its headings.'] });
    const wide = ['Vendor', ...Array.from({ length: 41 }, () => 'Rents')].join(',');
    expect(read1099Report(cells(wide), BOXES).problems[0]).toMatch(/41 columns of amounts; FleetSuite reads up to 40/);
  });

  it('reads a total by any of the names a report gives it', () => {
    for (const h of ['Total', 'Total 1099 Amount', '1099-MISC Total', 'Amount', 'Total Paid', 'Grand Total']) {
      expect(read1099Report(cells(`Vendor,${h}\nA,1`), BOXES).report?.columns, h).toEqual([{ key: 'c1', header: h, box: null }]);
    }
  });

  it('takes the vendor from another name column when there is no vendor column', () => {
    const { report } = read1099Report(cells('Legal Name,Print on Check As,Rents\nSample LLC,Sample,1'), BOXES);
    expect(report?.vendors).toEqual([{ label: 'Sample LLC', names: ['Sample'], amounts: { c1: 100 } }]);
  });

  it('leaves out a name column whose cells hold nine digits, and takes nine digits out of a vendor\'s name', () => {
    const { report } = read1099Report(cells('Vendor,Vendor ID,Rents\nSample 123456789 Co,12-3456789,1\nB Co,V-2,2'), BOXES);
    expect(report?.leftOut).toEqual(['Vendor ID']);
    expect(report?.vendors).toEqual([
      { label: 'Sample *** Co', names: [], amounts: { c1: 100 } },
      { label: 'B Co', names: [], amounts: { c1: 200 } },
    ]);
  });

  it('leaves out a tax ID column whatever its heading says, as only names and amounts are kept', () => {
    const headings = ['Tax ID', 'TIN', 'Vendor SSN', 'EIN/SSN', 'Federal ID Number', 'Tax Identification No.', 'Social Security #', 'Taxpayer ID'];
    const { report } = read1099Report(cells(`Name,${headings.join(',')},Rents\nA,${headings.map(() => '12-3456789').join(',')},2`), BOXES);
    expect(report?.leftOut).toEqual(headings);
    expect(report?.vendors).toEqual([{ label: 'A', names: [], amounts: { c1: 200 } }]);
    expect(JSON.stringify(report)).not.toContain('6789');
  });
});

async function xlsxFile(sheets: Array<{ name: string; rows: unknown[][] }>, name = 'report.xlsx'): Promise<File> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const r of sheet.rows) ws.addRow(r);
  }
  return new File([(await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer], name);
}

describe('reading the file', () => {
  it('reads an exported CSV, and the sheet of a workbook that has the report', async () => {
    const csv = new File(['\uFEFFVendor,Rents\r\nSample Co,"1,000.00"\r\n'], 'report.csv');
    expect((await read1099ReportFile(csv, BOXES)).report?.vendors).toEqual([{ label: 'Sample Co', names: [], amounts: { c1: 100000 } }]);
    const tsv = new File(['Vendor\tRents\nSample Co\t5'], 'report.txt');
    expect((await read1099ReportFile(tsv, BOXES)).report?.vendors).toEqual([{ label: 'Sample Co', names: [], amounts: { c1: 500 } }]);

    const book = await xlsxFile([
      { name: 'Notes', rows: [['Exported from NetSuite']] },
      { name: '1099', rows: [['Vendor', 'Tax ID', 'Rents'], ['Sample Co', '12-3456789', 1000.5]] },
    ]);
    const read = await read1099ReportFile(book, BOXES);
    expect(read.sheetName).toBe('1099');
    expect(read.report?.vendors).toEqual([{ label: 'Sample Co', names: [], amounts: { c1: 100050 } }]);
    expect(read.report?.leftOut).toEqual(['Tax ID']);

    const none = await read1099ReportFile(await xlsxFile([{ name: 'Notes', rows: [['Nothing here']] }]), BOXES);
    expect(none).toMatchObject({ report: null, sheetName: 'Notes' });
    expect(none.problems[0]).toMatch(/Couldn't find the report's headings/);
    expect(await read1099ReportFile(await xlsxFile([{ name: 'Empty', rows: [] }]), BOXES)).toEqual({ report: null, problems: ['That workbook is empty.'] });
  });

  it("says what it can't read", async () => {
    await expect(read1099ReportFile(new File(['x'], 'report.xls'), BOXES)).rejects.toThrow(/old \.xls file FleetSuite can't read/);
    await expect(read1099ReportFile(new File(['x'], 'report.pdf'), BOXES)).rejects.toThrow(/can't read a "\.pdf" file/);
    await expect(read1099ReportFile(new File(['not a workbook'], 'report.xlsx'), BOXES)).rejects.toThrow(/Couldn't read that workbook/);
    await expect(read1099ReportFile(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'report.csv'), BOXES)).rejects.toThrow(/too big/);
  });
});

describe('the pieces', () => {
  it('reads amounts the ways a spreadsheet writes them', () => {
    expect(readMoney('$1,234.56')).toBe(123456);
    expect(readMoney('(1,234.56)')).toBe(-123456);
    expect(readMoney('($5.00)')).toBe(-500);
    expect(readMoney('-0.29')).toBe(-29);
    expect(readMoney('.5')).toBe(50);
    expect(readMoney('7.')).toBe(700);
    expect(readMoney('0.00')).toBe(0);
    expect(readMoney('-0')).toBe(0);
    for (const blank of ['', '  ', '-', '–', '—']) expect(readMoney(blank)).toBeNull();
    for (const junk of ['abc', '1.2.3', '12-34', '1e5', '(5', '5)']) expect(readMoney(junk), junk).toBeNaN();
  });

  it('takes out nine digits in a row, one character apart at most', () => {
    expect(scrub('Sample 123-45-6789')).toBe('Sample ***');
    expect(scrub('12 3456789 Co')).toBe('*** Co');
    expect(scrub('EIN: 12.3456789')).toBe('EIN: ***');
    expect(scrub('  Route 66   Towing ')).toBe('Route 66 Towing');
    expect(scrub('(636) 555-1234')).toBe('(636) 555-1234');
    expect(scrub('12345678')).toBe('12345678');
    expect(scrub('x'.repeat(250))).toHaveLength(200);
    expect(hasNineDigits('1-2-3-4-5-6-7-8-9')).toBe(true);
    expect(hasNineDigits('12345678 9')).toBe(true);
    expect(hasNineDigits('12345678  9')).toBe(false);
    expect(hasNineDigits('1234a56789')).toBe(false);
  });

  it('compares names and boxes without case, accents, spacing or punctuation', () => {
    expect(nameKey('Sample  Café & Co.')).toBe(nameKey('SAMPLE CAFE AND CO'));
    expect(nameKey('*** ')).toBe('');
    expect(boxKey('Box 7 - Nonemployee Compensation (1099-NEC)')).toBe(boxKey('Non-employee compensation'));
    expect(boxKey('Rents Amount')).toBe('rents');
    expect(boxKey('Section 409A Deferrals')).toBe('section409adeferrals');
  });

  it("reads the years a report's title names", () => {
    expect(titleYears(['Sample Fleet Co', 'January 2025 - December 2025'])).toEqual([2025]);
    expect(titleYears(['1/1/2024 - 12/31/2025', 'run 2026'])).toEqual([2024, 2025, 2026]);
    expect(titleYears(['Item 120251', 'FY1999'])).toEqual([]);
  });
});

const REPORT: Report1099 & { fileName: string } = {
  fileName: '1099 Summary.csv',
  title: ['1099-MISC Summary'],
  columns: [{ key: 'c1', header: 'Rents', box: 'Rents' }, { key: 'c2', header: 'Total', box: null }],
  leftOut: ['Tax ID'],
  vendors: [{ label: 'Sample Co', names: ['Sample LLC'], amounts: { c1: 100, c2: 100 } }],
  skipped: { totals: 1, noName: 0, combined: 0 },
};

describe('checking what the route is sent', () => {
  it('takes a report the page read, rebuilt from only what is kept', () => {
    const sent = { ...REPORT, extra: 'x', vendors: [{ ...REPORT.vendors[0], tin: 'x', amounts: { c1: 100, c2: 0 } }] };
    expect(checkReport(sent)).toEqual({ report: { ...REPORT, vendors: [{ label: 'Sample Co', names: ['Sample LLC'], amounts: { c1: 100 } }] } });
    const counts = checkReport({ ...REPORT, skipped: { totals: -1, noName: 1.5, combined: '2' } });
    expect('report' in counts && counts.report.skipped).toEqual({ totals: 0, noName: 0, combined: 0 });
    const bare = checkReport({ fileName: ' f.csv ', columns: REPORT.columns, vendors: [{ label: ' A  Co ', amounts: {} }] });
    expect(bare).toEqual({
      report: { fileName: 'f.csv', title: [], columns: REPORT.columns, leftOut: [], vendors: [{ label: 'A Co', names: [], amounts: {} }], skipped: { totals: 0, noName: 0, combined: 0 } },
    });
  });

  it('refuses nine digits in a row anywhere, rather than cleaning them', () => {
    const tin = '12-3456789';
    for (const sent of [
      { ...REPORT, fileName: `${tin}.csv` },
      { ...REPORT, title: [`EIN ${tin}`] },
      { ...REPORT, leftOut: [tin] },
      { ...REPORT, columns: [{ key: 'c1', header: tin, box: 'Rents' }, REPORT.columns[1]] },
      { ...REPORT, columns: [{ key: 'c1', header: 'Rents', box: tin }, REPORT.columns[1]] },
      { ...REPORT, vendors: [{ label: `Sample ${tin}`, names: [], amounts: {} }] },
      { ...REPORT, vendors: [{ label: 'Sample', names: [tin], amounts: {} }] },
    ]) {
      const out = checkReport(sent);
      expect('error' in out && out.error, JSON.stringify(sent)).toMatch(/nine digits in a row/);
    }
  });

  it("refuses a report that isn't the shape the page sends", () => {
    const refused = (patch: Record<string, unknown>) => {
      const out = checkReport({ ...REPORT, ...patch });
      return 'error' in out ? out.error : null;
    };
    expect(checkReport(null)).toEqual({ error: 'No report to keep' });
    expect(refused({ fileName: ' ' })).toMatch(/file name/);
    expect(refused({ title: 'x' })).toMatch(/title/);
    expect(refused({ title: Array(7).fill('x') })).toMatch(/title/);
    expect(refused({ leftOut: [1] })).toMatch(/left-out/);
    expect(refused({ columns: [] })).toMatch(/1 to 40 columns/);
    expect(refused({ columns: [{ key: 'x1', header: 'Rents', box: 'Rents' }] })).toMatch(/key of its own/);
    expect(refused({ columns: [{ key: 'c1', header: 'A', box: null }, { key: 'c1', header: 'B', box: null }] })).toMatch(/key of its own/);
    expect(refused({ columns: [{ key: 'c1', header: ' ', box: null }] })).toMatch(/no heading/);
    expect(refused({ columns: [{ key: 'c1', header: 'Rents' }] })).toMatch(/names no box/);
    expect(refused({ columns: [{ key: 'c1', header: 'Rents', box: ' ' }] })).toMatch(/names no box/);
    expect(refused({ vendors: [] })).toMatch(/1 to 5,000 vendors/);
    expect(refused({ vendors: Array(5001).fill(REPORT.vendors[0]) })).toMatch(/1 to 5,000 vendors/);
    expect(refused({ vendors: [{ label: '***', names: [], amounts: {} }] })).toMatch(/Vendor 1 of the report has no name/);
    expect(refused({ vendors: [{ label: 'A', names: 'B', amounts: {} }] })).toMatch(/other names/);
    expect(refused({ vendors: [{ label: 'A', names: [], amounts: [] }] })).toMatch(/no amounts/);
    expect(refused({ vendors: [{ label: 'A', names: [], amounts: { c9: 1 } }] })).toMatch(/under no column/);
    expect(refused({ vendors: [{ label: 'A', names: [], amounts: { c1: 1.5 } }] })).toMatch(/whole cents/);
    expect(refused({ vendors: [{ label: 'A', names: [], amounts: { c1: '100' } }] })).toMatch(/whole cents/);
    expect(refused({ vendors: [{ label: 'A', names: [], amounts: { c1: 1e14 } }] })).toMatch(/whole cents/);
  });
});

// ── Side by side ─────────────────────────────────────────────────────────────

const payee = (id: string, name: string, boxes: Record<string, number>, extra: Partial<Payee1099> = {}): Payee1099 => ({
  payee: id, name, legalName: null, entityId: null, vendor: true, marked: true, paid: 0, boxes,
  total: Object.values(boxes).reduce((n, c) => n + c, 0), unsplit: 0, byCard: 0, payments: [], ...extra,
});

const yearOf = (parts: Partial<Year1099>): Year1099 => ({
  categories: ['Nonemployee Compensation', 'Rents'], forms: [], notMarked: [], nothingCounted: [], byCard: [], unsplit: [], notCopied: [],
  accounts: [
    { netsuiteId: '530', number: '5300', name: 'Subcontractors', category: 'Nonemployee Compensation' },
    { netsuiteId: '540', number: '5400', name: 'Rent', category: 'Rents' },
  ],
  totals: { boxes: {}, total: 0 }, flagsCopied: true, ...parts,
});

const reportOf = (vendors: Report1099['vendors'], columns: Report1099['columns'] = [
  { key: 'c1', header: 'Non-Employee Compensation', box: 'Non-Employee Compensation' },
  { key: 'c2', header: 'Rents', box: 'Rents' },
  { key: 'c3', header: 'Total', box: null },
]): Report1099 => ({ title: [], columns, leftOut: [], vendors, skipped: { totals: 0, noName: 0, combined: 0 } });

describe('NetSuite\'s report held against FleetSuite\'s year', () => {
  const painting = payee('50', 'Sample Painting', { 'Nonemployee Compensation': 150000 }, { legalName: 'Sample Painting LLC', entityId: 'V-50' });
  const rentals = payee('51', 'Example Rentals', { Rents: 240000, 'Nonemployee Compensation': 10000 }, { unsplit: 5000 });
  const labor = payee('52', 'Placeholder Labor', { 'Nonemployee Compensation': 30000 }, { marked: false });
  const hardware = payee('57', 'Example Hardware', { 'Nonemployee Compensation': 45000 });
  const signs = payee('53', 'Demo Signs', {}, { paid: 9000 });
  const year = yearOf({ forms: [rentals, painting, hardware], notMarked: [labor], nothingCounted: [signs] });

  it('matches each vendor and compares it box by box and in total, the differences first', () => {
    const cmp = compare1099(year, reportOf([
      { label: 'V-50 Sample Painting', names: [], amounts: { c1: 150000, c3: 150000 } },
      { label: 'EXAMPLE RENTALS', names: [], amounts: { c1: 10000, c2: 230000, c3: 240000 } },
      { label: 'Placeholder Labor', names: [], amounts: { c1: 30000, c3: 30000 } },
    ]));
    expect(cmp.boxes).toEqual(['Nonemployee Compensation', 'Rents']);
    expect(cmp.hasTotal).toBe(true);
    expect(cmp.vendors.map((v) => [v.name, v.same])).toEqual([
      ['Example Rentals', false], ['Sample Painting', true], ['Placeholder Labor', true],
    ]);
    expect(cmp.vendors[0]).toEqual({
      payee: '51', name: 'Example Rentals', legalName: null, marked: true, labels: ['EXAMPLE RENTALS'],
      netsuite: { total: 240000, boxes: { 'Nonemployee Compensation': 10000, Rents: 230000 } },
      fleetsuite: { total: 250000, boxes: { 'Nonemployee Compensation': 10000, Rents: 240000 } },
      differences: { total: -10000, boxes: { Rents: -10000 } },
      same: false,
      unsplit: 5000,
    });
    expect(cmp.vendors[2]).toMatchObject({ payee: '52', marked: false, same: true });
    expect(cmp.vendors[2].differences).toEqual({ total: 0, boxes: {} });
    expect(cmp.onlyInFleetSuite).toEqual([
      { payee: '57', name: 'Example Hardware', legalName: null, fleetsuite: { total: 45000, boxes: { 'Nonemployee Compensation': 45000 } } },
    ]);
    expect(cmp.counts).toEqual({ same: 2, differ: 1, onlyInReport: 0, onlyInFleetSuite: 1 });
  });

  it('finds a vendor by its legal name, its NetSuite id, or one of its other names', () => {
    for (const v of [
      { label: 'Sample Painting LLC', names: [] },
      { label: 'v 50', names: [] },
      { label: 'Someone Else', names: ['sample painting, llc'] },
    ]) {
      const cmp = compare1099(year, reportOf([{ ...v, amounts: { c1: 150000 } }]));
      expect(cmp.vendors.map((x) => x.payee), v.label).toEqual(['50']);
    }
  });

  it("lists a vendor it can't pin to one of FleetSuite's, and the names it could be", () => {
    const twin = payee('58', 'Sample Painting', { 'Nonemployee Compensation': 100 }, { legalName: 'Other Painting Inc' });
    const doubled = yearOf({ forms: [painting, twin] });
    const cmp = compare1099(doubled, reportOf([
      { label: 'Sample Painting', names: [], amounts: { c3: 100 } },
      { label: 'Nobody We Paid', names: [], amounts: { c1: 500, c3: 500 } },
    ]));
    expect(cmp.onlyInReport).toEqual([
      { label: 'Nobody We Paid', names: [], netsuite: { total: 500, boxes: { 'Nonemployee Compensation': 500, Rents: 0 } }, candidates: [] },
      { label: 'Sample Painting', names: [], netsuite: { total: 100, boxes: { 'Nonemployee Compensation': 0, Rents: 0 } }, candidates: ['Sample Painting', 'Sample Painting'] },
    ]);
    // Its other name says which.
    const told = compare1099(doubled, reportOf([{ label: 'Sample Painting', names: ['Other Painting Inc'], amounts: { c1: 100, c3: 100 } }]));
    expect(told.vendors.map((v) => v.payee)).toEqual(['58']);
    expect(told.vendors[0].same).toBe(true);
    // Its other names fitting both says nothing.
    const both = compare1099(doubled, reportOf([{ label: 'Nobody', names: ['Sample Painting LLC', 'Other Painting Inc'], amounts: {} }]));
    expect(both.onlyInReport[0].candidates).toEqual(['Sample Painting', 'Sample Painting']);
  });

  it("finds a vendor known by its NetSuite id when the report puts that before its name, and only then", () => {
    const person = payee('70', 'V1001', { 'Nonemployee Compensation': 80000 });
    const company = payee('71', '3M', { Rents: 100 });
    const sample = payee('73', 'Sample', { Rents: 7 });
    const both = yearOf({ forms: [person, company, sample] });
    const cmp = compare1099(both, reportOf([
      { label: 'V1001 Sample Person', names: [], amounts: { c1: 80000, c3: 80000 } },
      { label: '3M Company', names: [], amounts: { c2: 100, c3: 100 } },
      { label: 'Sample Person', names: [], amounts: { c3: 5 } },
      { label: 'V1001', names: [], amounts: { c3: 5 } },
    ]));
    expect(cmp.vendors.map((v) => [v.payee, v.labels, v.same])).toEqual([
      ['70', ['V1001 Sample Person', 'V1001'], false],
      ['71', ['3M Company'], true],
    ]);
    expect(cmp.onlyInReport.map((o) => o.label)).toEqual(['Sample Person']);
    expect(cmp.onlyInFleetSuite.map((o) => o.payee)).toEqual(['73']);
    // A first word with no digit in it isn't an id, and one of its other names says first.
    const named = compare1099(both, reportOf([
      { label: 'Sample V1001', names: [], amounts: {} },
      { label: 'V1001 Other', names: ['3M'], amounts: {} },
    ]));
    expect(named.onlyInReport.map((o) => o.label)).toEqual(['Sample V1001']);
    expect(named.vendors.map((v) => [v.payee, v.labels])).toEqual([['71', ['V1001 Other']]]);
  });

  it("matches a FleetSuite vendor whose name has nine digits in it, as the report's are taken out", () => {
    const odd = yearOf({ forms: [payee('72', 'Sample 123456789 Co', { Rents: 100 })] });
    const { report } = read1099Report(cells('Vendor,Rents\nSample 123456789 Co,1'), BOXES);
    expect(report?.vendors[0].label).toBe('Sample *** Co');
    expect(compare1099(odd, report!).vendors.map((v) => [v.payee, v.same])).toEqual([['72', true]]);
  });

  it('tells a vendor apart whose boxes differ although its total is the same', () => {
    const cmp = compare1099(year, reportOf([{ label: 'Sample Painting', names: [], amounts: { c2: 150000, c3: 150000 } }]));
    expect(cmp.vendors[0].differences).toEqual({ total: 0, boxes: { 'Nonemployee Compensation': -150000, Rents: 150000 } });
    expect(cmp.vendors[0].same).toBe(false);
    expect(cmp.counts).toMatchObject({ same: 0, differ: 1 });
  });

  it('adds up the rows that are the same vendor under different names', () => {
    const cmp = compare1099(year, reportOf([
      { label: 'Sample Painting', names: [], amounts: { c1: 100000, c3: 100000 } },
      { label: 'Sample Painting LLC', names: [], amounts: { c1: 50000, c3: 50000 } },
    ]));
    expect(cmp.vendors).toHaveLength(1);
    expect(cmp.vendors[0]).toMatchObject({ labels: ['Sample Painting', 'Sample Painting LLC'], same: true, netsuite: { total: 150000 } });
  });

  it('adds up the boxes for the total when the report has none, so a box it lacks shows as a difference', () => {
    const cmp = compare1099(year, reportOf(
      [{ label: 'Example Rentals', names: [], amounts: { c1: 240000 } }],
      [{ key: 'c1', header: 'Rents', box: 'Rents' }],
    ));
    expect(cmp.hasTotal).toBe(false);
    expect(cmp.vendors[0]).toMatchObject({ netsuite: { total: 240000 }, fleetsuite: { total: 250000 }, same: false });
    expect(cmp.vendors[0].netsuite.boxes).toEqual({ Rents: 240000 });
    expect(cmp.vendors[0].fleetsuite.boxes).toEqual({ Rents: 240000 });
    expect(cmp.vendors[0].differences).toEqual({ total: -10000, boxes: {} });
  });

  it('puts the largest difference first, then the matches by size', () => {
    const many = yearOf({ forms: [payee('1', 'A', { Rents: 100 }), payee('2', 'B', { Rents: 200 }), payee('3', 'C', { Rents: 300 }), payee('4', 'D', { Rents: 50 })] });
    const cmp = compare1099(many, reportOf([
      { label: 'A', names: [], amounts: { c2: 100, c3: 100 } },
      { label: 'B', names: [], amounts: { c2: 210, c3: 210 } },
      { label: 'C', names: [], amounts: { c2: 300, c3: 300 } },
      { label: 'D', names: [], amounts: { c2: 0, c3: 150 } },
    ]));
    expect(cmp.vendors.map((v) => v.name)).toEqual(['D', 'B', 'C', 'A']);
  });
});
