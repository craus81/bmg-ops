import { describe, expect, it } from 'vitest';
import { buildDivisionReport, buildRevenueByItemQuery, revenueBucket } from './division-revenue';

describe('revenueBucket (owner rule 2026-10-06)', () => {
  it('files the named graphics items and every 06 part as graphics', () => {
    expect(revenueBucket('3M Vinyl', 'NonInvtPart')).toBe('graphics');
    expect(revenueBucket('Graphics Install Labor', 'Service')).toBe('graphics');
    expect(revenueBucket('graphics removal', 'Service')).toBe('graphics');
    expect(revenueBucket('06U357', 'InvtPart')).toBe('graphics');
    expect(revenueBucket('Masterack : 06U357', 'InvtPart')).toBe('graphics');
  });

  it('files everything else, Parts Install Labor included, as upfit', () => {
    expect(revenueBucket('Parts Install Labor', 'Service')).toBe('upfit');
    expect(revenueBucket('LABOR', 'Service')).toBe('upfit');
    expect(revenueBucket('RD-1234', 'InvtPart')).toBe('upfit');
    expect(revenueBucket('60U357', 'InvtPart')).toBe('upfit');
  });

  it('leaves out freight, shipping and layout lines', () => {
    expect(revenueBucket('Freight', 'OthCharge')).toBe('excluded');
    expect(revenueBucket('Shipping & Handling', 'OthCharge')).toBe('excluded');
    expect(revenueBucket('UPS Ground', 'ShipItem')).toBe('excluded');
    expect(revenueBucket('Subtotal', 'Subtotal')).toBe('excluded');
    expect(revenueBucket(null, 'EndGroup')).toBe('excluded');
  });

  it('keeps discounts and item-less lines unsplit', () => {
    expect(revenueBucket('Fleet Discount', 'Discount')).toBe('unsplit');
    expect(revenueBucket(null, null)).toBe('unsplit');
  });
});

describe('buildDivisionReport', () => {
  const revenue = [
    { month: '2026-01', item_number: '3M Vinyl', item_type: 'NonInvtPart', amount: '1000' },
    { month: '2026-01', item_number: 'Graphics Install Labor', item_type: 'Service', amount: 500 },
    { month: '2026-01', item_number: 'Parts Install Labor', item_type: 'Service', amount: 2000 },
    { month: '2026-01', item_number: 'RD-1', item_type: 'InvtPart', amount: 3000 },
    { month: '2026-01', item_number: 'Freight', item_type: 'OthCharge', amount: 175 },
    { month: '2026-01', item_number: 'Fleet Discount', item_type: 'Discount', amount: -100 },
    { month: '2026-02', item_number: 'RD-1', item_type: 'InvtPart', amount: -250 }, // credit memo
  ];
  const labor = [{ month: '2026-01', upfit: 1500, graphics: 400, shared: 900, unassigned: 50 }];

  it('splits revenue by month and subtracts each side’s own labor', () => {
    const r = buildDivisionReport(revenue, labor);
    expect(r.months).toHaveLength(2);
    const jan = r.months[0];
    expect(jan).toMatchObject({
      month: '2026-01', upfitRevenue: 5000, graphicsRevenue: 1500, unsplitRevenue: -100, excludedRevenue: 175,
      upfitLabor: 1500, graphicsLabor: 400, sharedLabor: 900, unassignedLabor: 50, upfitAfterLabor: 3500, graphicsAfterLabor: 1100,
    });
    expect(r.months[1]).toMatchObject({ month: '2026-02', upfitRevenue: -250, upfitLabor: 0, upfitAfterLabor: -250 });
    expect(r.totals).toMatchObject({ upfitRevenue: 4750, graphicsRevenue: 1500, upfitAfterLabor: 3250, graphicsAfterLabor: 1100 });
  });

  it('names months with revenue but no payroll instead of treating labor as zero silently', () => {
    expect(buildDivisionReport(revenue, labor).monthsWithoutPayroll).toEqual(['2026-02']);
  });

  it('lists items by size with the side each landed on', () => {
    const items = buildDivisionReport(revenue, labor).items;
    expect(items[0]).toMatchObject({ item_number: 'RD-1', bucket: 'upfit', amount: 2750 });
    expect(items.find(i => i.item_number === 'FREIGHT')?.bucket).toBe('excluded');
  });
});

describe('buildRevenueByItemQuery', () => {
  it('nets invoices and credit memos over non-tax lines in the range', () => {
    const q = buildRevenueByItemQuery('2026-01-01', '2026-10-06');
    expect(q).toContain("t.type IN ('CustInvc', 'CustCred')");
    expect(q).toContain("tl.taxline = 'F'");
    expect(q).toContain("TO_DATE('2026-10-06', 'YYYY-MM-DD')");
  });
  it('refuses anything but plain dates', () => {
    expect(() => buildRevenueByItemQuery("2026-01-01' OR 1=1 --", '2026-10-06')).toThrow();
  });
});
