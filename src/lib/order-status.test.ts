import { describe, it, expect } from 'vitest';
import { deriveOrderStatus, fmtTimeOfDay, type OrderStatusInput } from './order-status';

const base = (over: Partial<OrderStatusInput> = {}): OrderStatusInput => ({
  approved: true,
  approvedAt: '2026-10-28T15:00:00Z',
  approvedBy: 'dan@acme.com',
  requests: [],
  dropShips: [],
  partsAllInAt: null,
  schedule: null,
  inShopAt: null,
  done: null,
  invoiced: null,
  ...over,
});
const req = (item: string, status: string, ordered_at: string | null = null) => ({ item_number: item, status, ordered_at });
const stateOf = (v: ReturnType<typeof deriveOrderStatus>) => Object.fromEntries(v.stages.map(s => [s.key, s.state]));

describe('deriveOrderStatus', () => {
  it('starts at Approved and names who approved', () => {
    const v = deriveOrderStatus(base());
    expect(v.current).toBe('approved');
    expect(v.stages[0]).toMatchObject({ state: 'now', detail: 'Oct 28 · by dan@acme.com' });
    expect(v.stages[1]).toMatchObject({ state: 'todo', detail: "We'll order anything we don't have on the shelf" });
  });

  it('shows ordering progress until every part is ordered', () => {
    const v = deriveOrderStatus(base({ requests: [req('A', 'ordered', '2026-10-29T15:00:00Z'), req('B', 'pending')] }));
    expect(v.current).toBe('approved');
    expect(v.stages[1].detail).toBe('1 of 2 parts ordered');
  });

  it('a part split by a partial order is not ordered until every row is', () => {
    const v = deriveOrderStatus(base({ requests: [req('A', 'ordered'), req('a', 'pending'), req('B', 'cancelled')] }));
    expect(v.current).toBe('approved');
    expect(v.stages[1].detail).toBe('0 of 1 parts ordered');
  });

  it('Parts ordered once all are on a PO, drop ships included', () => {
    const v = deriveOrderStatus(base({
      requests: [req('A', 'ordered', '2026-10-29T15:00:00Z')],
      dropShips: [{ item_numbers: ['B'], created_at: '2026-10-30T15:00:00Z' }],
    }));
    expect(v.current).toBe('parts_ordered');
    expect(v.stages[1]).toMatchObject({ state: 'now', detail: 'All 2 parts ordered · Oct 30' });
  });

  it('All parts in comes only from the manual mark', () => {
    const v = deriveOrderStatus(base({ partsAllInAt: '2026-11-04T15:00:00Z' }));
    expect(v.current).toBe('parts_in');
    expect(v.stages[1]).toMatchObject({ state: 'done', detail: 'Nothing needed ordering' });
    expect(v.stages[2]).toMatchObject({ state: 'now', detail: 'Everything is here · Nov 4' });
  });

  it('formats a shop drop-off and an onsite install', () => {
    const shop = deriveOrderStatus(base({ schedule: { date: '2026-11-11', time: '08:00:00', place: 'shop' } }));
    expect(shop.current).toBe('scheduled');
    expect(shop.stages[3].detail).toBe("Wed, Nov 11 · drop off 8:00 AM at our O'Fallon shop");
    const onsite = deriveOrderStatus(base({ schedule: { date: '2026-11-11', time: null, place: 'onsite' } }));
    expect(onsite.stages[3].detail).toBe('Wed, Nov 11 · install at your location');
  });

  it('a later stage marks every earlier one done', () => {
    const v = deriveOrderStatus(base({ inShopAt: '2026-11-11T14:12:00Z' }));
    expect(stateOf(v)).toEqual({
      approved: 'done', parts_ordered: 'done', parts_in: 'done', scheduled: 'done',
      in_shop: 'now', done: 'todo', invoiced: 'todo',
    });
    expect(v.stages[4].detail).toBe('Checked in Wed, Nov 11 · 8:12 AM');
  });

  it('Invoiced is the end: every stage done', () => {
    const v = deriveOrderStatus(base({
      done: { at: '2026-11-12T20:00:00Z', label: 'Ready for pickup' },
      invoiced: { at: '2026-11-12', number: 'INV1450' },
    }));
    expect(v.current).toBe('invoiced');
    expect(v.stages.every(s => s.state === 'done')).toBe(true);
    expect(v.stages[5].detail).toBe('Ready for pickup · Thu, Nov 12');
    expect(v.stages[6].detail).toBe('Invoice INV1450 · Nov 12');
  });
});

describe('fmtTimeOfDay', () => {
  it('reads Postgres TIME values', () => {
    expect(fmtTimeOfDay('08:00:00')).toBe('8:00 AM');
    expect(fmtTimeOfDay('13:30')).toBe('1:30 PM');
    expect(fmtTimeOfDay('00:15:00')).toBe('12:15 AM');
    expect(fmtTimeOfDay(null)).toBe('');
  });
});
