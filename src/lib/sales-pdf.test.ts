import { describe, it, expect } from 'vitest';
import { salesLinesFromRecord, salesPdfDataFromRecord } from './sales-pdf';
import { buildTransactionPdf } from './transaction-pdf';

const invoice = {
  id: '9001',
  tranId: 'INV2699',
  tranDate: '2026-11-06',
  dueDate: '2026-12-06',
  entity: { refName: 'Acme Plumbing Co.' },
  billAddress: 'Acme Plumbing Co.\n1 Depot Way\nSt. Charles MO 63301',
  shipAddress: 'Acme Plumbing Co.\n1 Depot Way\nSt. Charles MO 63301',
  terms: { refName: 'Net 30' },
  otherRefNum: '45120',
  createdFrom: { refName: 'Sales Order #SO1235' },
  custbody_vehicle_info_: 'Unit 112',
  custbody_vin_number_: '1FT7W2BT5SEC12345',
  status: { refName: 'Open' },
  subtotal: 1685.79,
  taxTotal: 113.13,
  total: 1798.92,
  item: { items: [
    { line: 1, itemType: 'InvtPart', item: { refName: 'BAK448146' }, description: 'BAKFlip MX4', quantity: -1, rate: 1137.5, amount: 1137.5 },
    { line: 2, itemType: { id: 'Description' }, item: { refName: 'Note' }, description: 'Installed at customer site' },
    { line: 3, itemType: 'Subtotal', item: { refName: 'Subtotal' }, amount: 1137.5 },
    { line: 4, itemType: 'Service', item: { refName: '06-INSTALL' }, description: 'Installation labor', quantity: 2.5, rate: 125, amount: 312.5 },
    { line: 5, itemType: 'Discount', item: { refName: 'Fleet discount' }, description: 'Fleet discount', rate: -50, amount: -50 },
  ] },
};

describe('sales-pdf', () => {
  it('keeps priced, description and discount lines; drops subtotal lines', () => {
    const lines = salesLinesFromRecord(invoice);
    expect(lines.map((l) => [l.itemNumber, l.quantity, l.cents, !!l.textOnly])).toEqual([
      ['BAK448146', 1, 113750, false],
      [null, null, 0, true],
      ['06-INSTALL', 2.5, 31250, false],
      ['Fleet discount', null, -5000, false],
    ]);
  });

  it('maps an invoice', () => {
    const d = salesPdfDataFromRecord('invoice', invoice, null);
    expect(d.number).toBe('INV2699');
    expect(d.party[0]).toBe('Acme Plumbing Co.');
    expect(d.details.map((x) => x.label)).toEqual(['Invoice date', 'Due date', 'Terms', 'Customer PO', 'Sales order', 'End user', 'VIN']);
    expect(d.details.find((x) => x.label === 'Sales order')?.value).toBe('SO1235');
    expect([d.subtotalCents, d.taxCents, d.totalCents]).toEqual([168579, 11313, 179892]);
    expect(d.stamp).toBeNull();
    expect(salesPdfDataFromRecord('invoice', { ...invoice, status: { refName: 'Paid In Full' } }, null).stamp).toBe('Paid');
  });

  it('maps a sales order', () => {
    const d = salesPdfDataFromRecord('sales_order', { ...invoice, tranId: 'SO1235', salesRep: { refName: 'Valarie' }, createdFrom: null, custbody_vin_number_: '' }, null);
    expect(d.kind).toBe('sales_order');
    expect(d.details.map((x) => x.label)).toEqual(['Order date', 'Customer PO', 'Terms', 'Sales rep', 'End user']);
    expect(Buffer.from(buildTransactionPdf(d).output('arraybuffer')).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('falls back to the customer name and adds up totals NetSuite left out', () => {
    const d = salesPdfDataFromRecord('invoice', { tranId: 'INV1', entity: { refName: 'Bob' }, item: { items: [{ itemType: 'Service', item: { refName: 'X' }, quantity: 1, rate: 10, amount: 10 }] } }, null);
    expect(d.party).toEqual(['Bob']);
    expect(d.shipTo).toEqual([]);
    expect([d.subtotalCents, d.taxCents, d.totalCents]).toEqual([1000, 0, 1000]);
  });
});
