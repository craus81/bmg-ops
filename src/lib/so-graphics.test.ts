import { describe, expect, it } from 'vitest';
import { buildSoJobPrefill, isSoGraphicsLine, soGraphicsLines, isGraphicsLaborLine } from './so-graphics';

const aloft = {
  header: {
    tranId: 'SO1482',
    customerName: '161205 A Skeetz Production',
    poNumber: 'EST-2610-070',
    memo: "Aloft Cooler Wraps\nDelivery: Onsite Installation · Install at: Aloft Hotel, 4245 Duncan Ave, St. Louis, MO 63110 · Contact: Adrienne Pumphrey · 314-639-0050\nFleetSuite Estimate #EST-2610-070",
    vin: '',
    endUser: '',
  },
  lines: [
    { itemNumber: '3M Vinyl', description: '3M Vinyl - Cooler Wrap X 2 - 92"X34.5" and 81"X24.5"', quantity: 1 },
    { itemNumber: 'Graphics Install Labor', description: 'Graphics Install Labor, includes: Wrapping 2 coolers', quantity: 1 },
  ],
};

describe('so graphics lines', () => {
  it('finds the 3M Vinyl and install labor lines, skips upfit parts', () => {
    const lines = [...aloft.lines, { itemNumber: '1234-SHELF', description: 'Shelf unit', quantity: 2 }];
    expect(soGraphicsLines(lines).map(l => l.itemNumber)).toEqual(['3M Vinyl', 'Graphics Install Labor']);
  });

  it('uses the catalog first, then the 02 / RM prefix', () => {
    const cat = new Map([['02-555', { catalog: 'upfit' }], ['DECAL-1', { catalog: 'graphics' }]]);
    expect(isSoGraphicsLine({ itemNumber: '02-555', description: null, quantity: 1 }, cat)).toBe(false);
    expect(isSoGraphicsLine({ itemNumber: '02-777', description: null, quantity: 1 }, cat)).toBe(true);
    expect(isSoGraphicsLine({ itemNumber: 'Decal-1', description: null, quantity: 1 }, cat)).toBe(true);
  });

  it('ignores closed lines', () => {
    expect(isSoGraphicsLine({ itemNumber: '3M Vinyl', description: null, quantity: 1, isClosed: true })).toBe(false);
  });

  it('labor is not a part to print', () => {
    expect(isGraphicsLaborLine(aloft.lines[1])).toBe(true);
    expect(isGraphicsLaborLine(aloft.lines[0])).toBe(false);
  });
});

describe('buildSoJobPrefill', () => {
  it('fills the New Job form from the order', () => {
    const p = buildSoJobPrefill(aloft);
    expect(p.title).toBe('Aloft Cooler Wraps');
    expect(p.customer).toBe('161205 A Skeetz Production');
    expect(p.partNumbers).toEqual(['3M Vinyl']);
    expect(p.quantity).toBe(1);
    expect(p.poNumber).toBe('EST-2610-070');
    expect(p.content).toContain('Cooler Wrap X 2');
    expect(p.content).toContain('SO #SO1482');
    expect(p.notes).toBe('Delivery: Onsite Installation\nInstall at: Aloft Hotel, 4245 Duncan Ave, St. Louis, MO 63110\nContact: Adrienne Pumphrey\n314-639-0050');
    expect(p.note).toContain('2 graphics lines');
  });

  it('falls back to customer + SO # and the SO # as PO, with the VIN tail', () => {
    const p = buildSoJobPrefill({ ...aloft, header: { ...aloft.header, memo: '', poNumber: '', vin: '1FTBW3XM5KKA12345' } });
    expect(p.title).toBe('161205 A Skeetz Production - SO #SO1482 · A12345');
    expect(p.poNumber).toBe('SO1482');
    expect(p.content).toContain('VIN 1FTBW3XM5KKA12345');
  });

  it('quantity falls back to 1 when the print lines disagree', () => {
    const p = buildSoJobPrefill({ ...aloft, lines: [
      { itemNumber: '02-100', description: 'Door decal', quantity: 2 },
      { itemNumber: '02-200', description: 'Hood decal', quantity: 3 },
    ] });
    expect(p.quantity).toBe(1);
    expect(p.quantityAmbiguous).toBe(true);
  });

  it('says so when nothing looks like graphics', () => {
    const p = buildSoJobPrefill({ ...aloft, lines: [{ itemNumber: 'SHELF', description: 'Shelf', quantity: 1 }] });
    expect(p.partNumbers).toEqual([]);
    expect(p.note).toContain('None of its lines look like graphics');
  });
});
