import { describe, it, expect } from 'vitest';
import {
  findLowStock, linearFeetForSqft, planDraw, stockVerdict, summarizeStock,
  type StockPolicy, type StockRoll,
} from './roll-stock';

const roll = (id: string, remainingQty: number, receivedAt: string, over: Partial<StockRoll> = {}): StockRoll => ({
  id, substrateId: 'f1', materialName: 'IJ280', kind: 'film', unit: 'ft',
  widthIn: 54, remainingQty, receivedAt, status: 'open', ...over,
});

describe('linearFeetForSqft', () => {
  it('converts printed area to roll feet at the roll width', () => {
    // 54" wide roll: 100 ft² = 14400 in² / 54" = 266.7" = 22.2 ft
    expect(linearFeetForSqft(100, 54)).toBe(22.2);
    expect(linearFeetForSqft(100, null)).toBeNull();
    expect(linearFeetForSqft(100, 0)).toBeNull();
  });
});

describe('summarizeStock', () => {
  it('folds open rolls per material and tracks the longest single roll', () => {
    const [s] = summarizeStock([
      roll('a', 20, '2026-01-01'),
      roll('b', 35, '2026-02-01'),
      roll('c', 12, '2026-03-01'),
    ]);
    expect(s).toMatchObject({ openRolls: 3, totalRemaining: 67, longestRoll: 35 });
  });

  it('ignores depleted, scrapped and empty rolls', () => {
    const out = summarizeStock([
      roll('a', 0, '2026-01-01'),
      roll('b', 10, '2026-01-02', { status: 'scrapped' }),
      roll('c', 10, '2026-01-03', { status: 'depleted' }),
    ]);
    expect(out).toEqual([]);
  });

  it('separates materials of different kinds that share a name', () => {
    const out = summarizeStock([
      roll('a', 10, '2026-01-01', { materialName: 'Clear', kind: 'premask' }),
      roll('b', 4, '2026-01-01', { materialName: 'Clear', kind: 'ink', unit: 'cartridge' }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('planDraw', () => {
  it('draws FIFO from the oldest roll first', () => {
    const plan = planDraw([roll('new', 100, '2026-03-01'), roll('old', 30, '2026-01-01')], 40);
    expect(plan.allocations).toEqual([{ rollId: 'old', take: 30 }, { rollId: 'new', take: 10 }]);
    expect(plan.shortfall).toBe(0);
  });

  it('flags a run that no single roll covers, even when the total is enough', () => {
    // 40 ft on hand across four remnants does not print a 38 ft job.
    const rolls = ['a', 'b', 'c', 'd'].map((id, i) => roll(id, 10, `2026-01-0${i + 1}`));
    const plan = planDraw(rolls, 38);
    expect(plan.shortfall).toBe(0);
    expect(plan.splitAcrossRolls).toBe(true);

    // One long roll covers it — no split warning.
    expect(planDraw([roll('big', 60, '2026-01-01')], 38).splitAcrossRolls).toBe(false);
  });

  it('reports the shortfall when stock cannot cover the run', () => {
    const plan = planDraw([roll('a', 12, '2026-01-01')], 30);
    expect(plan.shortfall).toBe(18);
    expect(plan.allocations).toEqual([{ rollId: 'a', take: 12 }]);
  });
});

describe('findLowStock', () => {
  const summaries = summarizeStock([
    roll('a', 15, '2026-01-01'),
    roll('b', 80, '2026-01-01', { materialName: '3M 40C', substrateId: 'f2' }),
  ]);
  const policy = (over: Partial<StockPolicy>): StockPolicy => ({
    key: 'film:IJ280', kind: 'film', materialName: 'IJ280', unit: 'ft',
    reorderAt: 50, orderUpTo: 200, vendorName: 'Grimco', itemNumber: 'IJ280-54', ...over,
  });

  it('raises only materials at or below their point, ordering up to the target', () => {
    const hits = findLowStock(summaries, [policy({}), policy({ key: 'film:3M 40C', materialName: '3M 40C' })]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ materialName: 'IJ280', onHand: 15, suggestedQty: 185 });
  });

  it('treats a material with stock tracked but no reorder point as watched, not ordered', () => {
    expect(findLowStock(summaries, [policy({ reorderAt: null })])).toEqual([]);
  });

  it('counts a material with no rolls at all as zero on hand', () => {
    const hits = findLowStock([], [policy({})]);
    expect(hits[0]).toMatchObject({ onHand: 0, suggestedQty: 200 });
  });
});

describe('stockVerdict', () => {
  const [ij] = summarizeStock([roll('a', 30, '2026-01-01'), roll('b', 25, '2026-02-01')]);

  it('is honest about a split run, a shortage, and an unknown', () => {
    expect(stockVerdict(38, ij).tone).toBe('warn');       // 55 ft total, longest 30
    expect(stockVerdict(60, ij).tone).toBe('short');
    expect(stockVerdict(20, ij).tone).toBe('ok');
    expect(stockVerdict(20, undefined).tone).toBe('unknown');
    expect(stockVerdict(null, ij).tone).toBe('unknown');
  });
});
