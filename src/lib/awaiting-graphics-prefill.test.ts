import { describe, it, expect } from 'vitest';
import {
  buildAwaitingPrefill, classifyGraphicsLine, prefillNote,
  type PrefillLine, type PrefillCatalogEntry,
} from './awaiting-graphics-prefill';

const cat = (item: string, catalog: string | null): [string, PrefillCatalogEntry] =>
  [item, { item_number: item, catalog, display_name: `${item} name` }];

const line = (item: string, qty: number | null = 1, description: string | null = null): PrefillLine =>
  ({ item_number: item, quantity: qty, description });

describe('classifyGraphicsLine', () => {
  it('takes the catalog over the prefix', () => {
    const c = new Map([cat('ZZ-900', 'graphics')]);
    expect(classifyGraphicsLine('ZZ-900', c.get('ZZ-900'))).toBe('catalog');
  });

  it('lets the catalog VETO a part number that merely looks like graphics', () => {
    // 02… is a supplier's PO convention. An item NetSuite files under
    // upfit is not graphics work just because its number starts with 02.
    const c = new Map([cat('02T278', 'upfit')]);
    expect(classifyGraphicsLine('02T278', c.get('02T278'))).toBeNull();
  });

  it('falls back to the prefix only when the catalog has never heard of it', () => {
    expect(classifyGraphicsLine('02T278', undefined)).toBe('prefix');
    expect(classifyGraphicsLine('RM530432', undefined)).toBe('prefix');
    expect(classifyGraphicsLine('06T278', undefined)).toBeNull();   // install charge
    expect(classifyGraphicsLine('', undefined)).toBeNull();
  });
});

describe('buildAwaitingPrefill', () => {
  const catalog = new Map([
    cat('GFX-1', 'graphics'),
    cat('SHELF-9', 'upfit'),
    cat('02T278', 'upfit'),
  ]);

  it('pulls the graphic lines and counts what it skipped', () => {
    const p = buildAwaitingPrefill(
      [line('GFX-1', 2), line('SHELF-9', 1), line('RM530432', 2), line('LABOR', 8)],
      catalog,
    );
    expect(p.partNumbers).toEqual(['GFX-1', 'RM530432']);
    expect(p.skipped).toBe(2);
    expect(p.counts).toEqual({ catalog: 1, prefix: 1 });
  });

  it('says which signal picked each line', () => {
    const p = buildAwaitingPrefill([line('GFX-1'), line('RM530432')], catalog);
    expect(p.matched.map(m => m.signal)).toEqual(['catalog', 'prefix']);
    expect(prefillNote(p)).toBe('2 graphic lines pulled in — 1 from the parts catalog, 1 by part-number prefix (02/RM).');
  });

  it('uses the shared quantity when the lines agree', () => {
    const p = buildAwaitingPrefill([line('GFX-1', 3), line('RM530432', 3)], catalog);
    expect(p.quantity).toBe(3);
    expect(p.quantityAmbiguous).toBe(false);
  });

  it('falls back to 1 and flags it when the lines disagree', () => {
    // The form takes ONE number and a wrong one prints the wrong amount
    // of vinyl, so this must not silently pick a line's count.
    const p = buildAwaitingPrefill([line('GFX-1', 3), line('RM530432', 7)], catalog);
    expect(p.quantity).toBe(1);
    expect(p.quantityAmbiguous).toBe(true);
    expect(prefillNote(p)).toContain('disagree on quantity');
  });

  it('makes one chip per part however many lines carry it', () => {
    const p = buildAwaitingPrefill([line('GFX-1', 2), line('GFX-1', 3)], catalog);
    expect(p.partNumbers).toEqual(['GFX-1']);
  });

  it('says so plainly when nothing on the order is graphics work', () => {
    const p = buildAwaitingPrefill([line('SHELF-9'), line('02T278')], catalog);
    expect(p.partNumbers).toHaveLength(0);
    expect(prefillNote(p)).toBe('None of the 2 sales-order lines look like graphics work.');
  });

  it('says so when there are no lines at all', () => {
    expect(prefillNote(buildAwaitingPrefill([], catalog)))
      .toBe('No sales-order lines found — nothing to prefill.');
  });

  it('treats a missing quantity as one rather than zero', () => {
    const p = buildAwaitingPrefill([line('GFX-1', null)], catalog);
    expect(p.quantity).toBe(1);
    expect(p.matched[0].quantity).toBe(1);
  });
});
