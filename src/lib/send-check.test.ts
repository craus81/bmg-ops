import { describe, it, expect } from 'vitest';
import { isFreightLine, sendCheckFindings, sendCheckLabel, type SendCheckLine } from './send-check';

const line = (over: Partial<SendCheckLine> = {}): SendCheckLine => ({
  item_number: 'CURT 13317', description: 'Receiver hitch', quantity: 1, unit_price: 289, labor_hours: 1.5, is_custom: false, ...over,
});
const freight = (price = 95) => line({ item_number: 'FREIGHT', description: 'Freight', unit_price: price, labor_hours: 0 });

describe('isFreightLine', () => {
  it('matches freight or shipping in the item number or description', () => {
    expect(isFreightLine({ item_number: 'FREIGHT', description: null })).toBe(true);
    expect(isFreightLine({ item_number: 'X1', description: 'Shipping from Buyers' })).toBe(true);
    expect(isFreightLine({ item_number: 'CURT 13317', description: 'Hitch' })).toBe(false);
  });
});

describe('sendCheckFindings', () => {
  it('is empty when labor is set and freight is charged', () => {
    expect(sendCheckFindings({ lines: [line(), freight()], labor_hours_override: null, labor_total: 187.5 })).toEqual([]);
  });

  it('names the lines with labor not set, labor at $0 and missing freight', () => {
    const f = sendCheckFindings({
      lines: [line({ item_number: 'BUY 8891040', labor_hours: null }), line({ item_number: 'BUY 3016800', labor_hours: null })],
      labor_hours_override: null, labor_total: 0,
    });
    expect(f).toEqual([
      '2 lines have labor not set: BUY 8891040, BUY 3016800',
      'Labor total is $0',
      'No freight line on this estimate',
    ]);
  });

  it('ignores custom lines and unset lines under a labor override', () => {
    expect(sendCheckFindings({ lines: [line({ is_custom: true, labor_hours: null }), freight()], labor_hours_override: null, labor_total: 50 })).toEqual([]);
    expect(sendCheckFindings({ lines: [line({ labor_hours: null }), freight()], labor_hours_override: 2, labor_total: 250 })).toEqual([]);
  });

  it('flags a freight line at $0', () => {
    expect(sendCheckFindings({ lines: [line(), freight(0)], labor_hours_override: null, labor_total: 100 })).toEqual(['Freight line is $0']);
  });

  it('shortens a long list of unset lines', () => {
    const lines = Array.from({ length: 6 }, (_, i) => line({ item_number: `P${i}`, labor_hours: null }));
    expect(sendCheckFindings({ lines: [...lines, freight()], labor_hours_override: null, labor_total: 10 })[0])
      .toBe('6 lines have labor not set: P0, P1, P2, P3 and 2 more');
  });
});

describe('sendCheckLabel', () => {
  it('adds the unit number when there is one', () => {
    expect(sendCheckLabel({ estimate_number: 'EST-2621', unit_number: '5102' })).toBe('EST-2621 (unit 5102)');
    expect(sendCheckLabel({ estimate_number: 'EST-2621' })).toBe('EST-2621');
  });
});
