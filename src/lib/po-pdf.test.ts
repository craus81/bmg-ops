import { describe, it, expect } from 'vitest';
import { addressTextLines, createdFromNumber, itemNumberFrom, poPdfDataFromRecord } from './po-pdf';
import { buildTransactionPdf, transactionPdfFilename } from './transaction-pdf';

const letterhead = {
  company: { name: 'BMG Fleet Installations LLC', address: '1082 Cool Springs Industrial Dr.', city: "O'Fallon", state: 'MO', zip: '63366', phone: null, email: 'inquiry@bmgfleet.com' },
  logoDataUrl: null,
};

const record = {
  id: '30500',
  tranId: '1452',
  tranDate: '2026-11-05',
  dueDate: '2026-11-12',
  entity: { id: '77', refName: 'Meyer Distributing' },
  billAddress: 'Meyer Distributing\nPO Box 1300\nJasper IN 47547',
  shipAddress: '',
  terms: { refName: 'Net 30' },
  employee: { refName: 'Jessie' },
  createdFrom: { refName: 'Sales Order #SO1235' },
  memo: 'Ship ground.',
  total: 1149.34,
  item: { items: [
    { line: 1, item: { id: '30068', refName: 'Bak Industries : BAK448146' }, description: 'BAKFlip MX4', quantity: 1, rate: 812.5, amount: 812.5 },
    { line: 2, item: { id: '123', refName: 'CUR13325' }, description: 'CURT hitch', quantity: 2, rate: 168.42, amount: 336.84 },
  ] },
};

describe('po-pdf', () => {
  it('reads helpers', () => {
    expect(addressTextLines('A<br>B\nC')).toEqual(['A', 'B', 'C']);
    expect(addressTextLines(null)).toEqual([]);
    expect(itemNumberFrom('Parent : X1')).toBe('X1');
    expect(createdFromNumber('Sales Order #SO1235')).toBe('SO1235');
    expect(createdFromNumber(null)).toBeNull();
  });

  it('maps a PO record', () => {
    const d = poPdfDataFromRecord(record, letterhead);
    expect(d.kind).toBe('purchase_order');
    expect(d.number).toBe('PO1452');
    expect(d.party).toEqual(['Meyer Distributing', 'PO Box 1300', 'Jasper IN 47547']);
    // No ship-to on the PO: BMG's own address from the letterhead.
    expect(d.shipTo).toEqual(['BMG Fleet Installations LLC', '1082 Cool Springs Industrial Dr.', "O'Fallon, MO 63366"]);
    expect(d.details).toEqual([
      { label: 'PO date', value: 'November 5, 2026' },
      { label: 'Terms', value: 'Net 30' },
      { label: 'Expected', value: 'November 12, 2026' },
      { label: 'Ordered by', value: 'Jessie' },
      { label: 'Our sales order', value: 'SO1235' },
    ]);
    expect(d.lines.map((l) => [l.itemNumber, l.quantity, l.cents])).toEqual([['BAK448146', 1, 81250], ['CUR13325', 2, 33684]]);
    expect(d.totalCents).toBe(114934);
    expect(d.taxCents).toBeNull();
    expect(d.memo).toBe('Ship ground.');
  });

  it('copes with a bare record', () => {
    const d = poPdfDataFromRecord({ tranId: 'PO9', entity: { refName: 'Acme' }, shipAddress: 'Cust\n1 Way', item: { items: [{ item: { id: '1', refName: 'X' }, quantity: -2, rate: 5 }] } }, null);
    expect(d.number).toBe('PO9');
    expect(d.party).toEqual(['Acme']);
    expect(d.shipTo).toEqual(['Cust', '1 Way']);
    expect(d.lines[0].quantity).toBe(2);
    expect(d.totalCents).toBe(-1000);
    expect(d.details.find((x) => x.label === 'Our sales order')).toBeUndefined();
  });

  it('adds the vendor name when the address leaves it out', () => {
    const d = poPdfDataFromRecord({ ...record, billAddress: 'PO Box 1300\nJasper IN 47547' }, letterhead);
    expect(d.party[0]).toBe('Meyer Distributing');
  });

  it('draws a PDF', () => {
    const bytes = buildTransactionPdf(poPdfDataFromRecord(record, letterhead)).output('arraybuffer');
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
    expect(transactionPdfFilename('purchase_order', 'PO1452')).toBe('PO1452.pdf');
    expect(transactionPdfFilename('invoice', 'INV2699')).toBe('Invoice_INV2699.pdf');
  });
});
