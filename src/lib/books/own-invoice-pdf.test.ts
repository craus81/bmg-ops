import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  billToLines, buildOwnInvoicePdf, cityLine, invoicePdfFilename, longDay, netsuitePdfFilename, ownInvoicePdfData,
  pageText, taxLabel, type InvoicePdfData,
} from './own-invoice-pdf';
import type { OwnInvoiceData } from './own-invoice-check';

const PAGE_H = 792;

/** Where jsPDF put each piece of text with exactly these words: [x, y from the top of the page], in points. */
function placed(out: string, text: string): Array<[number, number]> {
  // jsPDF escapes brackets and backslashes inside a string.
  const esc = text.replace(/[()\\]/g, '\\$&').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...out.matchAll(new RegExp(`([\\d.]+) ([\\d.]+) Td\\n\\(${esc}\\) Tj`, 'g'))]
    .map((m) => [Number(Number(m[1]).toFixed(2)), Number((PAGE_H - Number(m[2])).toFixed(2))]);
}

/** A made-up PNG logo `w` by `h` of colours that don't repeat, as a data URL. */
function pngLogo(w: number, h: number): string {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8; // bits per colour
  head[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) row.set([(x * 7 + y) & 255, (y * 3) & 255, 90], 1 + x * 3);
    rows.push(row);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const COMPANY = {
  name: 'BMG Fleet Installations', address: '100 Made Up Rd', city: "O'Fallon", state: 'MO', zip: '63366',
  phone: '(636) 555-0100', email: 'billing@example.com',
};

const data = (over: Partial<InvoicePdfData> = {}): InvoicePdfData => ({
  number: 'INV10001',
  date: '2026-11-18',
  dueDate: '2026-12-18',
  terms: 'Net 30',
  poNumber: '4500123',
  vin: '1FTBR1C82PKA00001',
  memo: null,
  customer: 'Gateway Plumbing Supply',
  billTo: ['1200 Industrial Dr', 'Springfield, MO 65802'],
  lines: [
    { itemNumber: 'RAN-1234', description: 'Ranger shelving package', quantity: 1, rate: 1845, cents: 184500, priced: true },
    { itemNumber: '06-LABOR', description: 'Installation labor', quantity: 6.5, rate: 95, cents: 61750, priced: true },
    { itemNumber: 'DISC', description: 'Fleet discount', quantity: null, rate: null, cents: -5000, priced: true },
  ],
  subtotalCents: 241250,
  taxCents: 15199,
  totalCents: 256449,
  taxBasis: 'rate',
  taxRate: 0.08238,
  voided: false,
  letterhead: { company: COMPANY, logoDataUrl: null },
  ...over,
});

const own = (over: Partial<OwnInvoiceData> = {}): OwnInvoiceData => ({
  netsuite_id: '123456',
  number: 'INV10001',
  made_from: 'vehicle',
  made_from_id: null,
  sales_order_id: '777',
  customer_netsuite_id: '42',
  customer_id: null,
  date: '2026-11-18',
  location_id: '1',
  location_from: 'sent',
  po_number: '4500123',
  memo: 'Unit 214',
  vin: '1FTBR1C82PKA00001',
  terms_id: '2',
  terms_name: 'Net 30',
  terms_days: 30,
  due_date: '2026-12-18',
  tax_rule: 'tax@2',
  tax_basis: 'rate',
  tax_rate: '0.082380',
  subtotal: '2412.50',
  tax: '151.99',
  total: '2564.49',
  lines_from: 'sent',
  unknowns: [],
  made_at: '2026-11-18T15:00:00Z',
  lines: [
    { line_no: 1, item_id: '9', item_number: 'RAN-1234', description: 'Ranger shelving package', quantity: '1.0000', rate: '1845.0000', amount: '1845.00', priced: true, taxable: true, tax: '151.99', sales_order_line_id: null },
    { line_no: 2, item_id: '10', item_number: '06-LABOR', description: null, quantity: '6.5000', rate: '95.0000', amount: '617.50', priced: true, taxable: false, tax: '0.00', sales_order_line_id: null },
    { line_no: 3, item_id: '11', item_number: 'DISC', description: 'Fleet discount', quantity: null, rate: null, amount: '-50.00', priced: true, taxable: false, tax: '0.00', sales_order_line_id: null },
  ],
  ...over,
});

describe('pageText', () => {
  it('folds what helvetica draws wrong and keeps Latin-1', () => {
    expect(pageText('Shelving — 3 tier “wide” … ‘ok’ • done')).toBe('Shelving - 3 tier "wide" ... \'ok\' - done');
    expect(pageText('Café 60° → ✓')).toBe('Café 60° ? ?');
    expect(pageText('  two\nlines\t here ')).toBe('two lines here');
  });
});

describe('cityLine and billToLines', () => {
  it('writes a city, state and ZIP as an envelope does, leaving out what is missing', () => {
    expect(cityLine('Springfield', 'MO', '65802')).toBe('Springfield, MO 65802');
    expect(cityLine(' Springfield ', '', '65802')).toBe('Springfield, 65802');
    expect(cityLine(null, 'MO', null)).toBe('MO');
    expect(cityLine('', ' ', null)).toBe('');
  });

  it('lists the address a line each with empties left out', () => {
    expect(billToLines({ addr1: '1200 Industrial Dr', addr2: '', city: 'Springfield', state: 'MO', zip: '65802' }))
      .toEqual(['1200 Industrial Dr', 'Springfield, MO 65802']);
    expect(billToLines({ addr1: ' 1 Main ', addr2: 'Suite 4' })).toEqual(['1 Main', 'Suite 4']);
    expect(billToLines(null)).toEqual([]);
    expect(billToLines({})).toEqual([]);
  });
});

describe('taxLabel', () => {
  it('names the rate, an exempt customer, or no tax', () => {
    expect(taxLabel('rate', 0.08238)).toBe('Sales tax (8.238%)');
    expect(taxLabel('rate', 0.0825)).toBe('Sales tax (8.25%)');
    expect(taxLabel('rate', 0)).toBe('Sales tax');
    expect(taxLabel('exempt_customer', 0)).toBe('Sales tax (exempt)');
    expect(taxLabel('georgia', 0)).toBe('Sales tax');
  });
});

describe('file names', () => {
  it("names the PDF Books opens after the invoice's number", () => {
    expect(invoicePdfFilename('INV10001')).toBe('Invoice_INV10001.pdf');
    expect(invoicePdfFilename('INV 10001/A')).toBe('Invoice_INV_10001_A.pdf');
    expect(invoicePdfFilename('***')).toBe('Invoice_Invoice.pdf');
  });

  it("names NetSuite's file after the number, NetSuite's id and the copy's version", () => {
    expect(netsuitePdfFilename('INV10001', '123456', 1)).toBe('Invoice_INV10001_123456.pdf');
    expect(netsuitePdfFilename('INV10001', '123456', 2)).toBe('Invoice_INV10001_123456_v2.pdf');
    expect(netsuitePdfFilename('INV 1', '9', 3)).toMatch(/^[A-Za-z0-9_.-]{1,120}\.pdf$/);
  });
});

describe('longDay', () => {
  it('writes a day in full', () => {
    expect(longDay('2026-11-18')).toBe('November 18, 2026');
    expect(longDay('2027-01-01')).toBe('January 1, 2027');
  });
});

describe('ownInvoicePdfData', () => {
  it("takes the page from FleetSuite's copy", () => {
    const d = ownInvoicePdfData(own(), {
      customer: 'Gateway Plumbing Supply',
      address: { addr1: '1200 Industrial Dr', city: 'Springfield', state: 'MO', zip: '65802' },
      voided: false,
      letterhead: null,
    });
    expect(d).toMatchObject({
      number: 'INV10001', date: '2026-11-18', dueDate: '2026-12-18', terms: 'Net 30', poNumber: '4500123',
      vin: '1FTBR1C82PKA00001', memo: 'Unit 214', customer: 'Gateway Plumbing Supply',
      billTo: ['1200 Industrial Dr', 'Springfield, MO 65802'],
      subtotalCents: 241250, taxCents: 15199, totalCents: 256449, taxBasis: 'rate', taxRate: 0.08238, voided: false,
      letterhead: null,
    });
    expect(d.lines).toEqual([
      { itemNumber: 'RAN-1234', description: 'Ranger shelving package', quantity: 1, rate: 1845, cents: 184500, priced: true },
      { itemNumber: '06-LABOR', description: null, quantity: 6.5, rate: 95, cents: 61750, priced: true },
      { itemNumber: 'DISC', description: 'Fleet discount', quantity: null, rate: null, cents: -5000, priced: true },
    ]);
  });

  it("falls back to NetSuite's id for the number, and carries a voided invoice and an unpriced line", () => {
    const d = ownInvoicePdfData(own({
      number: '  ',
      lines: [{ line_no: 1, item_id: null, item_number: null, description: 'Priced by NetSuite', quantity: '2', rate: '', amount: '0', priced: false, taxable: false, tax: '0', sales_order_line_id: null }],
    }), { customer: null, address: null, voided: true, letterhead: null });
    expect(d.number).toBe('123456');
    expect(d.voided).toBe(true);
    expect(d.billTo).toEqual([]);
    expect(d.lines).toEqual([{ itemNumber: null, description: 'Priced by NetSuite', quantity: 2, rate: null, cents: 0, priced: false }]);
    expect(ownInvoicePdfData(own({ number: null }), { customer: null, address: null, voided: false, letterhead: null }).number).toBe('123456');
  });
});

describe('buildOwnInvoicePdf', () => {
  it('draws the letterhead, who it is billed to, the details, each line and the totals', () => {
    const doc = buildOwnInvoicePdf(data());
    const out = doc.output();
    expect(out.startsWith('%PDF')).toBe(true);
    expect(doc.getNumberOfPages()).toBe(1);
    expect(placed(out, 'Invoice')).toEqual([[40, 60]]);
    expect(placed(out, 'INV10001')).toHaveLength(1);
    expect(placed(out, 'INV10001')[0][1]).toBe(60);
    expect(placed(out, 'BMG Fleet Installations')).toEqual([[40, 96]]);
    expect(placed(out, "O'Fallon, MO 63366")).toEqual([[40, 120]]);
    expect(placed(out, 'billing@example.com')).toEqual([[40, 144]]);
    expect(placed(out, 'Bill to')).toHaveLength(1);
    expect(placed(out, 'Gateway Plumbing Supply')[0][1]).toBe(108);
    expect(placed(out, 'Springfield, MO 65802')[0][1]).toBe(132);
    for (const text of ['November 18, 2026', 'December 18, 2026', 'Net 30', '4500123', '1FTBR1C82PKA00001']) {
      expect(placed(out, text)).toHaveLength(1);
    }
    for (const text of ['RAN-1234', 'Ranger shelving package', '6.5', '$95.00', '$617.50', 'Fleet discount', '-$50.00']) {
      expect(placed(out, text)).toHaveLength(1);
    }
    // Its rate, and what the line charges.
    expect(placed(out, '$1,845.00')).toHaveLength(2);
    expect(placed(out, 'Subtotal')).toHaveLength(1);
    expect(placed(out, '$2,412.50')).toHaveLength(1);
    expect(placed(out, 'Sales tax (8.238%)')).toHaveLength(1);
    expect(placed(out, '$151.99')).toHaveLength(1);
    expect(placed(out, 'Total')).toHaveLength(1);
    expect(placed(out, '$2,564.49')).toHaveLength(1);
    expect(out).toContain('Thank you for your business. Please contact BMG Fleet Installations with any questions about this invoice.');
    expect(out).not.toContain('Voided');
    expect(out).not.toContain('Memo:');
  });

  it('marks a voided invoice, writes the memo, and dashes what the invoice does not have', () => {
    const out = buildOwnInvoicePdf(data({
      voided: true, memo: 'Unit 214 — rack', dueDate: null, terms: null, poNumber: ' ', vin: null, letterhead: null,
      lines: [{ itemNumber: null, description: null, quantity: 2, rate: 12.3456, cents: 0, priced: false }],
      taxBasis: 'exempt_customer', taxRate: 0, taxCents: 0,
    })).output();
    expect(placed(out, 'Voided')).toHaveLength(1);
    expect(placed(out, 'Memo: Unit 214 - rack')).toHaveLength(1);
    expect(placed(out, '-')).toHaveLength(4);
    expect(placed(out, 'Not priced')).toHaveLength(1);
    expect(placed(out, '$12.3456')).toHaveLength(1);
    expect(placed(out, 'Sales tax (exempt)')).toHaveLength(1);
    // No letterhead: the company's name alone, and no lines under it.
    expect(placed(out, 'BMG Fleet')).toEqual([[40, 96]]);
    expect(out).toContain('Please contact BMG Fleet with any questions');
  });

  it('puts the logo above the title when there is one, and survives one it cannot read', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const withLogo = buildOwnInvoicePdf(data({ letterhead: { company: COMPANY, logoDataUrl: PNG } })).output();
    expect(withLogo).toContain('/Subtype /Image');
    expect(placed(withLogo, 'Invoice')).toEqual([[40, 92]]);
    const broken = buildOwnInvoicePdf(data({ letterhead: { company: COMPANY, logoDataUrl: 'data:image/png;base64,AAAA' } })).output();
    expect(placed(broken, 'Invoice')).toEqual([[40, 60]]);
  });

  it('keeps a full-size logo small, so the PDF stays under what NetSuite is sent', () => {
    const plain = buildOwnInvoicePdf(data()).output().length;
    const withLogo = buildOwnInvoicePdf(data({ letterhead: { company: COMPANY, logoDataUrl: pngLogo(300, 100) } })).output().length;
    // Kept uncompressed, this logo alone adds 90 KB.
    expect(withLogo - plain).toBeLessThan(20_000);
  });

  it('runs onto more pages for a long invoice and puts the totals once, after the last line', () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({ itemNumber: `P-${i + 1}`, description: `Part ${i + 1}`, quantity: 1, rate: 10, cents: 1000, priced: true }));
    const doc = buildOwnInvoicePdf(data({ lines, subtotalCents: 80000, taxCents: 0, totalCents: 80000, taxRate: 0 }));
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    const out = doc.output();
    expect(placed(out, 'Subtotal')).toHaveLength(1);
    expect(placed(out, 'P-80')).toHaveLength(1);
    expect(out.lastIndexOf('(P-80) Tj')).toBeLessThan(out.indexOf('(Subtotal) Tj'));
  });
});
