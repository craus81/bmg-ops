import { describe, it, expect } from 'vitest';
import { summarizeYield, yieldTotals, type YieldLine } from './material-yield';

const line = (over: Partial<YieldLine> = {}): YieldLine => ({
  materialName: 'IJ280', substrateId: 'f1', rollSqft: 100, graphicSqft: 80, cost: 110, ...over,
});

describe('summarizeYield', () => {
  it('computes waste, utilization and the cost of the scrap', () => {
    const [f] = summarizeYield([line(), line({ rollSqft: 50, graphicSqft: 45, cost: 55 })]);
    expect(f).toMatchObject({ rollSqft: 150, graphicSqft: 125, wasteSqft: 25, measuredLines: 2 });
    expect(f.utilization).toBeCloseTo(0.833, 3);
    // 25/150 of $165 of measured film.
    expect(f.wasteCost).toBeCloseTo(27.5, 1);
  });

  it('treats a line with no graphic area as UNKNOWN, never as total waste', () => {
    const [f] = summarizeYield([line(), line({ graphicSqft: null, cost: 40 })]);
    expect(f).toMatchObject({ measuredLines: 1, unmeasuredLines: 1, rollSqft: 100, wasteSqft: 20 });
    // The unmeasured line's 100 ft² did not get counted as scrap.
    expect(f.utilization).toBeCloseTo(0.8, 3);
  });

  it('folds by catalog id when linked and by name otherwise, and sorts worst waste first', () => {
    const rows = summarizeYield([
      line({ materialName: 'ij280 ', substrateId: 'f1', rollSqft: 10, graphicSqft: 9 }),
      line({ materialName: 'IJ280', substrateId: 'f1', rollSqft: 10, graphicSqft: 9 }),
      line({ materialName: '3M 40C', substrateId: null, rollSqft: 100, graphicSqft: 40, cost: 90 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].materialName).toBe('3M 40C');   // 60 ft² wasted
    expect(rows[1].rollSqft).toBe(20);             // the two IJ280 spellings folded
  });

  it('reports nothing measurable rather than dividing by zero', () => {
    const [f] = summarizeYield([line({ rollSqft: null, graphicSqft: null, cost: null })]);
    expect(f).toMatchObject({ measuredLines: 0, unmeasuredLines: 1, utilization: null, wasteCost: null });
  });
});

describe('yieldTotals', () => {
  it('rolls films into one honest total with its coverage', () => {
    const t = yieldTotals(summarizeYield([
      line({ rollSqft: 100, graphicSqft: 80, cost: 110 }),
      line({ materialName: '3M 40C', substrateId: null, rollSqft: 100, graphicSqft: 50, cost: 90 }),
      line({ graphicSqft: null }),
    ]));
    expect(t).toMatchObject({ rollSqft: 200, graphicSqft: 130, wasteSqft: 70, measuredLines: 2, unmeasuredLines: 1 });
    expect(t.utilization).toBeCloseTo(0.65, 3);
  });
});
