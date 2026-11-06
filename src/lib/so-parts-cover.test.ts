import { describe, it, expect } from 'vitest';
import { deriveSoPartsCover, shareStock, isCountedItem, coverLabel, partCoverText, type CoverOrder } from './so-parts-cover';

const m = (o: Record<string, number>) => new Map(Object.entries(o));
const order = (key: string, date: string, needed: Record<string, number>, onPo: Record<string, number> = {}, held: Record<string, number> = {}): CoverOrder =>
  ({ key, date, netsuiteId: key.replace(/\D/g, '') || '1', needed: m(needed), onPo: m(onPo), held: m(held) });

describe('isCountedItem', () => {
  it('counts physical parts only', () => {
    expect(isCountedItem('N5-RS60', 'InvtPart')).toBe(true);
    expect(isCountedItem('BAR-8', 'Kit')).toBe(true);
    expect(isCountedItem('LABOR', 'Service')).toBe(false);
    expect(isCountedItem('06-1001', 'InvtPart')).toBe(false);
    expect(isCountedItem('FS-CUSTOM', 'NonInvtPart')).toBe(false);
    expect(isCountedItem('X', null)).toBe(false);
  });
});

describe('shareStock', () => {
  it('gives the shelf to the oldest order first', () => {
    const out = shareStock([order('b2', '2026-11-03', { A: 1 }), order('a1', '2026-11-01', { A: 1 })], m({ A: 1 }));
    expect(out.get('a1')?.get('A')).toBe(1);
    expect(out.get('b2')?.get('A')).toBeUndefined();
  });

  it('a hold for an order wins over an older order', () => {
    const out = shareStock([order('a1', '2026-11-01', { A: 1 }), order('b2', '2026-11-03', { A: 1 }, {}, { A: 1 })], m({ A: 1 }));
    expect(out.get('b2')?.get('A')).toBe(1);
    expect(out.get('a1')?.get('A')).toBeUndefined();
  });

  it('parts already on a PO take nothing from the shelf', () => {
    const out = shareStock([order('a1', '2026-11-01', { A: 2 }, { A: 2 }), order('b2', '2026-11-03', { A: 2 })], m({ A: 2 }));
    expect(out.get('a1')?.get('A')).toBeUndefined();
    expect(out.get('b2')?.get('A')).toBe(2);
  });

  it('never hands out more than the shelf has', () => {
    const out = shareStock([order('a1', '2026-11-01', { A: 3 }), order('b2', '2026-11-02', { A: 3 })], m({ A: 4 }));
    expect(out.get('a1')?.get('A')).toBe(3);
    expect(out.get('b2')?.get('A')).toBe(1);
  });
});

describe('deriveSoPartsCover', () => {
  it('green when every part is on a PO or in stock', () => {
    const c = deriveSoPartsCover({ needed: m({ A: 1, B: 2, C: 3 }), onPo: m({ A: 1, C: 1 }), fromStock: m({ B: 2, C: 2 }) })!;
    expect(c.allReady).toBe(true);
    expect(c.parts.map(p => [p.item_number, p.state])).toEqual([['A', 'po'], ['B', 'stock'], ['C', 'mixed']]);
    expect(coverLabel(c)).toBe('Parts ordered');
  });

  it('counts what is missing, missing parts first', () => {
    const c = deriveSoPartsCover({ needed: m({ A: 1, B: 2 }), onPo: m({ A: 1 }), fromStock: m({ B: 1 }) })!;
    expect(c.allReady).toBe(false);
    expect(coverLabel(c)).toBe('1 of 2 ready');
    expect(c.parts[0].item_number).toBe('B');
    expect(partCoverText(c.parts[0])).toBe('1 of 2 covered');
  });

  it('generic parts never count stock', () => {
    const c = deriveSoPartsCover({ needed: m({ MISC: 1 }), onPo: m({}), fromStock: m({ MISC: 5 }), noStock: new Set(['MISC']) })!;
    expect(c.allReady).toBe(false);
    expect(partCoverText(c.parts[0])).toBe('Not ordered');
  });

  it('no part lines means no badge', () => {
    expect(deriveSoPartsCover({ needed: m({}), onPo: m({}), fromStock: m({}) })).toBeNull();
  });

  it('a hand mark turns it green until a new part shows up', () => {
    const mark = { at: '2026-11-06T12:00:00Z', byName: 'Jessie', items: ['A', 'B'] };
    const c = deriveSoPartsCover({ needed: m({ A: 1, B: 1 }), onPo: m({}), fromStock: m({}), mark })!;
    expect(c.allReady).toBe(true);
    expect(c.marked?.byName).toBe('Jessie');
    const later = deriveSoPartsCover({ needed: m({ A: 1, B: 1, C: 1 }), onPo: m({}), fromStock: m({}), mark })!;
    expect(later.allReady).toBe(false);
    expect(later.marked).toBeNull();
  });
});
