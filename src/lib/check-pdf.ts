/**
 * A payment run's checks laid out on BMG's pre-printed voucher check stock
 * (Books part 58, src/lib/check-printing.ts, docs/books.md "Checks printed
 * on BMG's stock"): one check a letter-size sheet, the check in one part and
 * a stub listing the bills it pays in each of the other two, for the vendor
 * and for BMG. The stock carries the bank's details, the MICR line, the check
 * number and the signature line already, so only the date, the payee, the
 * amount in figures and in words, the address for the envelope's window and
 * the memo go on the check. Where they land is the bank account's layout:
 * the check's part of the sheet, moved right and down in sixteenths of an
 * inch. The test page prints a made-up check the same way, marked as a test,
 * with the sheet's parts drawn, for holding against the stock.
 *
 * buildChecksPdf is pure (testable in node); openChecksPdf shows it in the
 * tab the click opened.
 */

import jsPDF from 'jspdf';
import { openPdfBytes } from './native-files';
import {
  SAMPLE_CHECK, amountInFigures, amountInWords, checkDate, formatCents, stubLines, type CheckLayout, type CheckPosition,
  type PrintedCheck,
} from './check-printing';

const INCH = 72;

/** Where each part of a sheet starts, from the top, in inches: the check's part and the two stubs. */
const PARTS: Readonly<Record<CheckPosition, { check: number; stubs: [number, number] }>> = {
  top: { check: 0, stubs: [3.5, 7] },
  middle: { check: 3.5, stubs: [0, 7] },
  bottom: { check: 7, stubs: [0, 3.5] },
};

/** Where each thing goes on the check, in inches from the top left of the check's part (x, then the baseline). */
export const CHECK_FIELDS = {
  date: [6.75, 0.7],
  payee: [1.0, 1.36],
  amount: [6.95, 1.36],
  words: [0.45, 1.7],
  address: [1.0, 2.05],
  memo: [0.75, 3.05],
} as const;

/** Where the words line ends: what it doesn't fill is filled with stars, so nothing can be added after it. */
const WORDS_END = 7.0;
const RIGHT_EDGE = 7.75;

/** Text at a size that fits in this width, shrinking to 7 points, then cut to fit. */
function fitted(doc: jsPDF, text: string, width: number, size: number): { text: string; size: number } {
  let s = size;
  doc.setFontSize(s);
  while (s > 7 && doc.getTextWidth(text) > width) {
    s -= 0.5;
    doc.setFontSize(s);
  }
  let t = text;
  while (t.length > 1 && doc.getTextWidth(t) > width) t = t.slice(0, -1);
  return { text: t, size: s };
}

function drawCheck(doc: jsPDF, check: PrintedCheck, top: number, dx: number) {
  const at = (field: keyof typeof CHECK_FIELDS): [number, number] => [CHECK_FIELDS[field][0] * INCH + dx, top + CHECK_FIELDS[field][1] * INCH];
  doc.setTextColor(0);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(checkDate(check.date), ...at('date'));

  doc.setFont('helvetica', 'bold');
  const payee = fitted(doc, check.payee, (CHECK_FIELDS.amount[0] - CHECK_FIELDS.payee[0] - 0.4) * INCH, 11);
  doc.setFontSize(payee.size);
  doc.text(payee.text, ...at('payee'));

  doc.setFontSize(11);
  doc.text(amountInFigures(check.cents), ...at('amount'));

  doc.setFont('helvetica', 'normal');
  const [wx, wy] = at('words');
  const wordsWidth = (WORDS_END - CHECK_FIELDS.words[0]) * INCH;
  const words = fitted(doc, amountInWords(check.cents), wordsWidth, 10);
  doc.setFontSize(words.size);
  let line = `${words.text} `;
  while (doc.getTextWidth(`${line}*`) <= wordsWidth) line += '*';
  doc.text(line, wx, wy);

  doc.setFontSize(10);
  const [ax, ay] = at('address');
  [check.payee, ...check.address].slice(0, 5).forEach((l, i) => {
    doc.text(fitted(doc, l, 3.5 * INCH, 10).text, ax, ay + i * 12);
    doc.setFontSize(10);
  });

  if (check.memo) {
    doc.setFontSize(9);
    doc.text(fitted(doc, check.memo, 3.2 * INCH, 9).text, ...at('memo'));
  }
}

function drawStub(doc: jsPDF, check: PrintedCheck, top: number, dx: number) {
  const x = (inches: number) => inches * INCH + dx;
  const y = (inches: number) => top + inches * INCH;
  doc.setTextColor(0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(fitted(doc, check.vendorName, 4.6 * INCH, 10).text, x(0.5), y(0.4));
  doc.setFontSize(10);
  doc.text(`Check ${check.number}`, x(RIGHT_EDGE), y(0.4), { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(fitted(doc, [checkDate(check.date), check.memo].filter(Boolean).join(' · '), 4.6 * INCH, 9).text, x(0.5), y(0.58));
  doc.setFontSize(9);
  doc.text(fitted(doc, check.accountName, 2.6 * INCH, 9).text, x(RIGHT_EDGE), y(0.58), { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(90);
  doc.text('BILL', x(0.5), y(0.88));
  doc.text('DATE', x(4.6), y(0.88));
  doc.text('PAID', x(RIGHT_EDGE), y(0.88), { align: 'right' });
  doc.setDrawColor(150);
  doc.line(x(0.5), y(0.93), x(RIGHT_EDGE), y(0.93));

  doc.setTextColor(0);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const lines = stubLines(check.bills);
  lines.forEach((l, i) => {
    const ly = y(1.08) + i * 12;
    doc.text(fitted(doc, l.text, 3.9 * INCH, 9).text, x(0.5), ly);
    doc.setFontSize(9);
    if (l.date) doc.text(l.date, x(4.6), ly);
    doc.text(formatCents(l.cents), x(RIGHT_EDGE), ly, { align: 'right' });
  });
  const totalY = y(1.08) + lines.length * 12 + 6;
  doc.line(x(5.9), totalY - 9, x(RIGHT_EDGE), totalY - 9);
  doc.setFont('helvetica', 'bold');
  doc.text('Total', x(4.6), totalY);
  doc.text(formatCents(check.cents), x(RIGHT_EDGE), totalY, { align: 'right' });
}

/** One sheet a check, each laid out the bank account's way. With `test`, the sheet's parts are drawn and the check is marked as a test. */
export function buildChecksPdf(checks: readonly PrintedCheck[], layout: CheckLayout, opts: { test?: boolean } = {}): jsPDF {
  if (checks.length === 0) throw new Error('There are no checks to print');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const parts = PARTS[layout.position] ?? PARTS.top;
  const dx = (layout.right / 16) * INCH;
  const dy = (layout.down / 16) * INCH;

  checks.forEach((check, i) => {
    if (i > 0) doc.addPage();
    if (opts.test) {
      // The perforations as the stock has them, not moved: hold the sheet against the stock and line these up.
      doc.setDrawColor(170);
      doc.setLineDashPattern([4, 3], 0);
      for (const at of [3.5, 7]) doc.line(0, at * INCH, pageW, at * INCH);
      doc.setLineDashPattern([], 0);
      // Right of the address, clear of everything printed on the check.
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.setTextColor(150);
      doc.text('TEST · NOT A CHECK · VOID', RIGHT_EDGE * INCH + dx, parts.check * INCH + 2.45 * INCH + dy, { align: 'right' });
    }
    drawCheck(doc, check, parts.check * INCH + dy, dx);
    for (const stub of parts.stubs) drawStub(doc, check, stub * INCH + dy, dx);
    if (opts.test) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(110);
      doc.text(
        'Print at actual size (100%), not fit to page. Hold this against a sheet of the check stock: move it on the Pay Vendors page until each line sits where it should.',
        0.5 * INCH, parts.stubs[1] * INCH + 3.3 * INCH, { maxWidth: 7.25 * INCH },
      );
      doc.setTextColor(0);
    }
  });
  return doc;
}

/** The checks' file name: checks-1050-1052.pdf, check-1050.pdf, or check-test.pdf. */
export function checksFilename(numbers: readonly number[], test = false): string {
  if (test || numbers.length === 0) return 'check-test.pdf';
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted.length === 1 ? `check-${sorted[0]}.pdf` : `checks-${sorted[0]}-${sorted[sorted.length - 1]}.pdf`;
}

/** The test page: the made-up check, laid out the bank account's way. */
export const buildTestPdf = (layout: CheckLayout) => buildChecksPdf([SAMPLE_CHECK], layout, { test: true });

/**
 * Show the checks in the tab the click opened (`w`, opened before anything was awaited so the popup blocker lets it
 * through), with Print and Save. Closes the tab when they can't be made.
 */
export function openChecksPdf(w: Window | null, checks: readonly PrintedCheck[], layout: CheckLayout, opts: { test?: boolean } = {}): { ok: boolean; error?: string } {
  try {
    const doc = opts.test ? buildTestPdf(layout) : buildChecksPdf(checks, layout);
    openPdfBytes(w, doc.output('arraybuffer'), checksFilename(checks.map((c) => c.number), opts.test));
    return { ok: true };
  } catch (e: any) {
    w?.close();
    return { ok: false, error: e?.message || "Couldn't make the checks" };
  }
}
