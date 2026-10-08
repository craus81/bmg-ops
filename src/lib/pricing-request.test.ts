import { describe, expect, it } from 'vitest';
import {
  defaultPriceSheetLines, matchScore, newPartPairs, pricingRequestStage, quotedPrices, rankRequestsForPair,
  type PoLineForLink,
} from './pricing-request';

const line = (id: string, part_number: string, extra: Partial<PoLineForLink> = {}): PoLineForLink => ({
  id, part_number, description: null, unit_price: null, part_id: null, part_netsuite_id: null, ...extra,
});

describe('pricingRequestStage', () => {
  const open = { status: 'open' as const, po_id: null };
  it('reads the stage off the price sheet', () => {
    expect(pricingRequestStage(open, null)).toBe('new');
    expect(pricingRequestStage(open, { status: 'draft', customer_approved: false, grand_total: 0 })).toBe('pricing');
    expect(pricingRequestStage(open, { status: 'sent', customer_approved: false, grand_total: 500 })).toBe('sent');
    expect(pricingRequestStage(open, { status: 'rejected', customer_approved: false, grand_total: 500 })).toBe('changes_requested');
    expect(pricingRequestStage(open, { status: 'sent', customer_approved: true, grand_total: 500 })).toBe('approved');
    expect(pricingRequestStage(open, { status: 'accepted', customer_approved: false, grand_total: 500 })).toBe('approved');
  });
  it('a PO link wins over the sheet, and manual end states win over everything', () => {
    const sheet = { status: 'accepted', customer_approved: true, grand_total: 500 };
    expect(pricingRequestStage({ status: 'open', po_id: 'po' }, sheet)).toBe('on_po');
    expect(pricingRequestStage({ status: 'closed', po_id: 'po' }, sheet)).toBe('closed');
    expect(pricingRequestStage({ status: 'declined', po_id: null }, sheet)).toBe('declined');
  });
});

describe('quotedPrices', () => {
  it('splits install lines from the graphic', () => {
    const lines = defaultPriceSheetLines('Orkin').map((l, i) => ({ ...l, unit_price: i === 0 ? 410.5 : 125 }));
    expect(quotedPrices(lines)).toEqual({ part: 410.5, install: 125 });
  });
  it('counts an 06 item number as install and sums quantities', () => {
    expect(quotedPrices([
      { item_number: '02T278', description: 'Decal kit', quantity: 2, unit_price: 100 },
      { item_number: '06T278', description: 'Labor', quantity: 1, unit_price: 80 },
    ])).toEqual({ part: 200, install: 80 });
  });
});

describe('newPartPairs', () => {
  it('pairs new 02 and 06 lines by suffix and skips real NetSuite items', () => {
    const pairs = newPartPairs([
      line('a', '02T278', { part_id: 'p1', part_netsuite_id: null }),
      line('b', '06t278', { part_id: 'p2', part_netsuite_id: 'LOCAL-1' }),
      line('c', '02U100', { part_id: 'p3', part_netsuite_id: '12345' }),
      line('d', 'RM530432'),
      line('e', '06X9'),
    ]);
    expect(pairs.map(p => [p.suffix, p.partLine?.id || null, p.installLine?.id || null])).toEqual([
      ['T278', 'a', 'b'],
      ['X9', null, 'e'],
    ]);
  });
  it('leaves out numbers already linked to a request', () => {
    expect(newPartPairs([line('a', '02T278'), line('b', '06T278')], ['02t278', '06T278'])).toEqual([]);
  });
});

describe('rankRequestsForPair', () => {
  const pair = { suffix: 'T278', partLine: line('a', '02T278', { description: 'ORKIN TRANSIT DECAL KIT' }), installLine: null };
  const req = (id: string, company_name: string, stage: any, received_date = '2026-10-01', po_id: string | null = null) =>
    ({ id, company_name, stage, received_date, po_id });

  it('scores by company words in the PO line text', () => {
    expect(matchScore({ company_name: 'Orkin' }, pair)).toBe(1);
    expect(matchScore({ company_name: 'Glass America' }, pair)).toBe(0);
  });

  it('puts the matching company first, then approved, then newest; drops requests already on a PO', () => {
    const ranked = rankRequestsForPair([
      req('1', 'Glass America', 'approved', '2026-10-05'),
      req('2', 'Orkin', 'sent'),
      req('3', 'Terminix', 'approved', '2026-09-01'),
      req('4', 'Orkin', 'approved', '2026-10-01', 'po-1'),
      req('5', 'Orkin', 'new'),
    ], pair);
    expect(ranked.map(r => r.id)).toEqual(['2', '5', '1', '3']);
  });
});
