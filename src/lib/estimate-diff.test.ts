import { describe, it, expect } from 'vitest';
import { diffEstimates, deltaLabel } from './estimate-diff';

const head = (over = {}) => ({
  subtotal: 1000, labor_total: 500, labor_hours: 5, labor_hours_override: null,
  tax_amount: 79.5, grand_total: 1579.5, vehicle_count: 1, ...over,
});
const ln = (over = {}) => ({
  item_number: 'RACK-1', description: 'Roof rack', quantity: 2, unit_price: 200,
  labor_hours: 1, line_total: 400, ...over,
});

describe('diffEstimates — lines', () => {
  it('says nothing moved when nothing moved', () => {
    const d = diffEstimates(head(), [ln()], head(), [ln()]);
    expect(d.identical).toBe(true);
    expect(d.counts).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 1 });
  });

  it('marks a price change as CHANGED, carrying both sides', () => {
    const d = diffEstimates(head(), [ln()], head(), [ln({ unit_price: 150, line_total: 300 })]);
    expect(d.counts.changed).toBe(1);
    expect(d.lines[0].before?.unitPrice).toBe(200);
    expect(d.lines[0].after?.unitPrice).toBe(150);
  });

  it('catches a quantity change the price hides', () => {
    const d = diffEstimates(head(), [ln()], head(), [ln({ quantity: 1, line_total: 200 })]);
    expect(d.lines[0].kind).toBe('changed');
  });

  it('catches a labor change with identical money — hours are sold too', () => {
    const d = diffEstimates(head(), [ln()], head(), [ln({ labor_hours: 2 })]);
    expect(d.lines[0].kind).toBe('changed');
  });

  it('reports an added line and a removed line', () => {
    const d = diffEstimates(head(), [ln()], head(), [ln({ item_number: 'CAM-2', description: 'Camera' })]);
    expect(d.counts.added).toBe(1);
    expect(d.counts.removed).toBe(1);
    expect(d.counts.changed).toBe(0);
  });

  it('matches custom lines on description when there is no item number', () => {
    const custom = { item_number: null, description: 'Custom bracket', quantity: 1, unit_price: 90, labor_hours: 0, line_total: 90 };
    const d = diffEstimates(head(), [custom], head(), [{ ...custom, unit_price: 75, line_total: 75 }]);
    expect(d.counts.changed).toBe(1);
  });

  it('is case- and whitespace-insensitive on the item number', () => {
    const d = diffEstimates(head(), [ln({ item_number: ' rack-1 ' })], head(), [ln({ item_number: 'RACK-1' })]);
    expect(d.counts.unchanged).toBe(1);
  });

  it('zips duplicates of one item number in order, then reports the leftover', () => {
    const d = diffEstimates(head(), [ln(), ln()], head(), [ln()]);
    expect(d.counts.unchanged).toBe(1);
    expect(d.counts.removed).toBe(1);
    expect(d.counts.changed).toBe(0);
  });

  it('puts what moved at the top — the untouched lines are not why anyone opened this', () => {
    const d = diffEstimates(
      head(),
      [ln(), ln({ item_number: 'B', description: 'B' })],
      head(),
      [ln({ unit_price: 100, line_total: 200 }), ln({ item_number: 'B', description: 'B' })],
    );
    expect(d.lines[0].kind).toBe('changed');
    expect(d.lines[d.lines.length - 1].kind).toBe('unchanged');
  });
});

describe('diffEstimates — totals', () => {
  it('reports the money deltas with direction', () => {
    const d = diffEstimates(head(), [], head({ grand_total: 1200, subtotal: 800 }), []);
    expect(d.grandTotal).toEqual({ before: 1579.5, after: 1200, change: -379.5 });
    expect(d.subtotal.change).toBe(-200);
  });

  it('uses the labor OVERRIDE when one is set, on either side', () => {
    const d = diffEstimates(
      head({ labor_hours: 5, labor_hours_override: 8 }),
      [],
      head({ labor_hours: 5, labor_hours_override: null }),
      [],
    );
    expect(d.laborHours).toEqual({ before: 8, after: 5, change: -3 });
  });

  it('tracks a change in vehicle count — the same lines at a different fleet size', () => {
    const d = diffEstimates(head(), [], head({ vehicle_count: 12 }), []);
    expect(d.vehicleCount.change).toBe(11);
    expect(d.identical).toBe(false);
  });

  it('treats a missing vehicle count as 1 on either side', () => {
    const d = diffEstimates(head({ vehicle_count: undefined }), [], head({ vehicle_count: 1 }), []);
    expect(d.vehicleCount.change).toBe(0);
  });

  it('is NOT identical when the lines match but the total moved — a rate or tax change is a change', () => {
    const d = diffEstimates(head(), [ln()], head({ grand_total: 1400 }), [ln()]);
    expect(d.identical).toBe(false);
  });
});

describe('deltaLabel', () => {
  it('names the direction a rep cares about', () => {
    expect(deltaLabel({ before: 1000, after: 600, change: -400 }, { money: true })).toBe('$400.00 lower');
    expect(deltaLabel({ before: 600, after: 1000, change: 400 }, { money: true })).toBe('$400.00 higher');
  });

  it('says unchanged rather than "$0.00 higher"', () => {
    expect(deltaLabel({ before: 10, after: 10, change: 0 })).toBe('unchanged');
  });

  it('reads plainly for hours', () => {
    expect(deltaLabel({ before: 8, after: 5, change: -3 })).toBe('3 lower');
  });
});
