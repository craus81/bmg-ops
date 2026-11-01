import { describe, expect, it } from 'vitest';
import { CHECK_FIELDS, buildChecksPdf, buildTestPdf, checksFilename } from './check-pdf';
import { SAMPLE_CHECK, STUB_LINES, type CheckLayout, type PrintedCheck } from './check-printing';

const TOP: CheckLayout = { position: 'top', right: 0, down: 0 };
const PAGE_H = 792;

/** Inches as points, to the hundredth jsPDF writes. */
const pt = (inches: number) => Number((inches * 72).toFixed(2));

/** Where jsPDF put each piece of text with exactly these words: [x, y from the top of the page], in points. */
function placed(out: string, text: string): Array<[number, number]> {
  const esc = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...out.matchAll(new RegExp(`([\\d.]+) ([\\d.]+) Td\\n\\(${esc}\\) Tj`, 'g'))]
    .map((m) => [Number(Number(m[1]).toFixed(2)), Number((PAGE_H - Number(m[2])).toFixed(2))]);
}

const check = (over: Partial<PrintedCheck> = {}): PrintedCheck => ({ ...SAMPLE_CHECK, ...over });

describe('buildChecksPdf', () => {
  it('prints what changes on the check, and both stubs with the bills it pays', () => {
    const doc = buildChecksPdf([check()], TOP);
    const out = doc.output();
    expect(out.startsWith('%PDF')).toBe(true);
    expect(doc.getNumberOfPages()).toBe(1);
    expect(placed(out, '11/06/2026')).toEqual([[pt(6.75), pt(0.7)]]);
    // Made out to on the payee line, and again over the address for the window.
    expect(placed(out, 'Ozark Hose & Fitting').slice(0, 2)).toEqual([[72, pt(1.36)], [72, pt(2.05)]]);
    expect(placed(out, '**1,412.40')).toEqual([[pt(6.95), pt(1.36)]]);
    expect(out).toMatch(/\(One thousand four hundred twelve and 40\/100 \*{20,}\) Tj/);
    expect(placed(out, '1200 Industrial Dr')).toEqual([[72, pt(2.05) + 12]]);
    expect(placed(out, 'Springfield, MO 65802')).toEqual([[72, pt(2.05) + 24]]);
    expect(placed(out, 'November run')).toEqual([[pt(0.75), pt(3.05)]]);
    // Each stub: the vendor, the check's number, the day and memo, the bank account, each bill and the total.
    expect(placed(out, 'Check 1001').map(([, y]) => y)).toEqual([pt(3.9), pt(7.4)]);
    expect(placed(out, 'Bill B-4410')).toEqual([[36, pt(3.5 + 1.08)], [36, pt(7 + 1.08)]]);
    expect(placed(out, '$812.40')).toHaveLength(2);
    expect(placed(out, '$600.00')).toHaveLength(2);
    expect(placed(out, '10/06/2026')).toHaveLength(2);
    expect(placed(out, 'Total')).toHaveLength(2);
    expect(placed(out, '$1,412.40')).toHaveLength(2);
    expect(placed(out, '10100 Operating Checking')).toHaveLength(2);
    // Nothing the stock carries already, and no test marks.
    expect(out).not.toContain('NOT A CHECK');
    expect(out).not.toMatch(/\[4\. 3\.\] 0\. d/);
  });

  it('puts the check in the part of the sheet the stock has it, and moves the print as the layout says', () => {
    const date = (layout: CheckLayout) => placed(buildChecksPdf([check()], layout).output(), '11/06/2026')[0];
    expect(date({ position: 'middle', right: 0, down: 0 })).toEqual([pt(6.75), pt(3.5 + 0.7)]);
    expect(date({ position: 'bottom', right: 0, down: 0 })).toEqual([pt(6.75), pt(7 + 0.7)]);
    expect(date({ position: 'top', right: 8, down: 4 })).toEqual([pt(6.75 + 0.5), pt(0.7 + 0.25)]);
    expect(date({ position: 'top', right: -16, down: -2 })).toEqual([pt(6.75 - 1), pt(0.7 - 0.125)]);

    const stubs = (layout: CheckLayout) => placed(buildChecksPdf([check()], layout).output(), 'Bill B-4410').map(([, y]) => y);
    expect(stubs({ position: 'middle', right: 0, down: 0 })).toEqual([pt(1.08), pt(7 + 1.08)]);
    expect(stubs({ position: 'bottom', right: 0, down: 0 })).toEqual([pt(1.08), pt(3.5 + 1.08)]);
    expect(stubs({ position: 'top', right: 2, down: 2 })).toEqual([pt(3.5 + 1.08 + 0.125), pt(7 + 1.08 + 0.125)]);
    expect(placed(buildChecksPdf([check()], { position: 'top', right: 2, down: 0 }).output(), 'Bill B-4410')[0][0]).toBe(36 + 9);
  });

  it('prints one check a sheet, in the order given', () => {
    const doc = buildChecksPdf([check({ number: 1050 }), check({ number: 1051, payee: 'Gateway Steel', vendorName: 'Gateway Steel' })], TOP);
    expect(doc.getNumberOfPages()).toBe(2);
    const out = doc.output();
    expect(out.indexOf('(Check 1050)')).toBeLessThan(out.indexOf('(Check 1051)'));
    expect(placed(out, 'Gateway Steel')).toHaveLength(4);
  });

  it('leaves out a memo and an address it has none of', () => {
    const out = buildChecksPdf([check({ memo: '', address: [] })], TOP).output();
    expect(placed(out, 'Ozark Hose & Fitting')).toHaveLength(4);
    expect(placed(out, '1200 Industrial Dr')).toHaveLength(0);
    expect(placed(out, 'November run')).toHaveLength(0);
    expect(placed(out, '11/06/2026')).toHaveLength(3);
  });

  it('lists as many bills as fit on a stub, and one line for the rest', () => {
    const bills = Array.from({ length: 20 }, (_, i) => ({ number: `B-${100 + i}`, date: '2026-10-01', cents: 1000 }));
    const out = buildChecksPdf([check({ bills, cents: 20000 })], TOP).output();
    expect(placed(out, `Bill B-${100 + STUB_LINES - 2}`)).toHaveLength(2);
    expect(placed(out, `Bill B-${100 + STUB_LINES - 1}`)).toHaveLength(0);
    expect(placed(out, `and ${20 - STUB_LINES + 1} more bills`)).toHaveLength(2);
    expect(placed(out, '$90.00')).toHaveLength(2);
    expect(placed(out, '$200.00')).toHaveLength(2);
  });

  it('shrinks a long name to fit its line, and cuts what still won\'t', () => {
    const long = `The Greater Southwest Missouri Hydraulic Hose, Fitting and Industrial Supply Cooperative Company of Springfield ${'and Branson '.repeat(6)}`.trim();
    const out = buildChecksPdf([check({ payee: long })], TOP).output();
    // The payee line, in bold at 7 points, cut short; the window's copy cut shorter still.
    expect(out).toMatch(/\/F2 7 Tf\n[\d.]+ TL\n0\. g\n72\. 694\.08\d* Td\n\(The Greater/);
    expect(out).not.toContain(`(${long}) Tj`);
    const printed = [...out.matchAll(/\((The Greater[^)]*)\) Tj/g)].map((m) => m[1]);
    expect(printed).toHaveLength(2);
    for (const p of printed) expect(long.startsWith(p) && p.length < long.length).toBe(true);
    expect(() => buildChecksPdf([check({ cents: 1_000_000_000 })], TOP)).not.toThrow();
  });

  it('refuses to make an empty file', () => {
    expect(() => buildChecksPdf([], TOP)).toThrow(/no checks/);
  });
});

describe('the test page', () => {
  it("prints the made-up check the bank account's way, marked as a test, with the sheet's parts drawn where the stock has them", () => {
    const doc = buildTestPdf({ position: 'top', right: 4, down: 4 });
    const out = doc.output();
    expect(doc.getNumberOfPages()).toBe(1);
    expect(out).toContain('NOT A CHECK');
    expect(out).toContain('Print at actual size \\(100%\\)');
    expect(out).toMatch(/\[4\. 3\.\] 0\. d/);
    // The print moves; the perforations stay where the stock has them, to hold it against.
    expect(out).toContain(`0. ${PAGE_H - 3.5 * 72}. m`);
    expect(out).toContain(`0. ${PAGE_H - 7 * 72}. m`);
    expect(placed(out, '11/06/2026')[0]).toEqual([pt(6.75 + 0.25), pt(0.7 + 0.25)]);
    expect(placed(out, '**1,412.40')).toHaveLength(1);
  });
});

describe('checksFilename', () => {
  it('names the file by its check numbers', () => {
    expect(checksFilename([1052, 1050, 1051])).toBe('checks-1050-1052.pdf');
    expect(checksFilename([1050])).toBe('check-1050.pdf');
    expect(checksFilename([])).toBe('check-test.pdf');
    expect(checksFilename([1050], true)).toBe('check-test.pdf');
  });
});

it('keeps every field on the check inside its part of the sheet', () => {
  for (const [x, y] of Object.values(CHECK_FIELDS)) {
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(8.5);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(3.5);
  }
});
