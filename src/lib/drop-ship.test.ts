import { describe, it, expect } from 'vitest';
import {
  buildDropShipVendorEmail, dropShipLines, dropShipSoPatch, planDropShip, sameShipTo, shipToFromRecord, shipToLines,
  EMPTY_SHIP_TO, type ShipTo,
} from './drop-ship';

const record = () => ({
  id: '5512',
  tranId: 'SO1180',
  entity: { id: '77', refName: 'Hosemate' },
  shippingAddress: { addressee: 'Hosemate', addr1: '100 Main St', city: 'Dayton', state: 'OH', zip: '45402', country: { id: 'US' } },
  item: {
    items: [
      { line: 1, item: { id: '9001', refName: 'N5-RS60-4' }, itemType: 'InvtPart', description: 'Roof rack', quantity: 1, quantityFulfilled: 0, quantityBilled: 0, rate: 400, amount: 400 },
      { line: 2, item: { id: '50', refName: 'LABOR' }, itemType: 'Service', description: 'Install', quantity: 2, rate: 95, amount: 190 },
      { line: 3, item: { id: '9002', refName: 'CLAMP-2' }, itemType: 'InvtPart', quantity: 2, quantityFulfilled: 2, rate: 10, amount: 20 },
      { line: 4, item: { id: '9003', refName: 'BAR-8' }, itemType: 'InvtPart', quantity: 1, rate: 50, amount: 50, createdPo: { id: '880', refName: 'Purchase Order #PO459-HOSEMATE' } },
    ],
  },
});

const ship: ShipTo = { ...EMPTY_SHIP_TO, name: 'Hosemate', address: '100 Main St', city: 'Dayton', state: 'OH', zip: '45402' };

describe('dropShipLines', () => {
  it('offers part lines and says why the others are out', () => {
    const lines = dropShipLines(record());
    expect(lines.map(l => [l.line, l.blocked])).toEqual([
      [1, null],
      [2, 'Not a part (labor, service or charge)'],
      [3, "Already shipped from O'Fallon"],
      [4, 'Already on PO PO459-HOSEMATE'],
    ]);
    expect(lines[3].createdPo).toEqual({ id: '880', number: 'PO459-HOSEMATE' });
  });
});

describe('ship-to', () => {
  it('reads the sales order ship-to and prints it line by line', () => {
    const s = shipToFromRecord(record());
    expect(s).toMatchObject(ship);
    expect(shipToLines(s)).toEqual(['Hosemate', '100 Main St', 'Dayton, OH 45402']);
  });

  it('compares addresses ignoring case and spaces at the ends', () => {
    expect(sameShipTo(ship, { ...ship, city: ' dayton ' })).toBe(true);
    expect(sameShipTo(ship, { ...ship, address: '200 Oak Ave' })).toBe(false);
  });
});

describe('planDropShip', () => {
  const lines = dropShipLines(record());

  it('takes an open part line with its cost', () => {
    const plan = planDropShip(lines, [{ line: 1, rate: 312.5 }], ship);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.map(l => [l.line, l.rate])).toEqual([[1, 312.5]]);
  });

  it('refuses blocked lines, repeats and an incomplete address', () => {
    expect(planDropShip(lines, [], ship)).toMatchObject({ ok: false });
    expect(planDropShip(lines, [{ line: 4 }], ship)).toMatchObject({ ok: false, error: expect.stringMatching(/Already on PO/) });
    expect(planDropShip(lines, [{ line: 1 }, { line: 1 }], ship)).toMatchObject({ ok: false, error: expect.stringMatching(/twice/) });
    expect(planDropShip(lines, [{ line: 9 }], ship)).toMatchObject({ ok: false });
    expect(planDropShip(lines, [{ line: 1 }], { ...ship, zip: '' })).toMatchObject({ ok: false, error: expect.stringMatching(/ZIP/) });
  });
});

describe('dropShipSoPatch', () => {
  it('marks each line Drop Ship for the vendor, with the cost when there is one', () => {
    expect(dropShipSoPatch([{ line: 1, rate: 312.5 }, { line: 5, rate: null }], '321')).toEqual({
      item: {
        items: [
          { line: 1, createPo: { id: 'DropShip' }, poVendor: { id: '321' }, poRate: 312.5 },
          { line: 5, createPo: { id: 'DropShip' }, poVendor: { id: '321' } },
        ],
      },
    });
  });
});

describe('buildDropShipVendorEmail', () => {
  it('puts the ship-to and lines in the email and escapes them', () => {
    const { subject, html } = buildDropShipVendorEmail({
      poNumber: 'PO460-HOSEMATE',
      customerName: 'Hosemate',
      shipTo: { ...ship, attention: 'Dock <2>' },
      lines: [{ itemNumber: 'N5-RS60-4', description: 'Roof rack', quantity: 1 }],
      message: 'Ship ground please',
      signatureHtml: '',
      pdfName: 'PO460-HOSEMATE.pdf',
    });
    expect(subject).toBe('Drop ship PO PO460-HOSEMATE: please ship direct to Hosemate');
    expect(html).toContain('Please ship directly to:');
    expect(html).toContain('Attn: Dock &lt;2&gt;');
    expect(html).toContain('N5-RS60-4');
    expect(html).toContain('PO460-HOSEMATE.pdf');
  });
});
