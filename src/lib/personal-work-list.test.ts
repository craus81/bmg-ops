import { describe, it, expect } from 'vitest';
import {
  orderPersonalList, compareGraphicsDefault, compareVehicleDefault, sanitizeOrder,
} from './personal-work-list';

const g = (id: string, work_rank: number | null, due_date: string | null = null, created_at = '2026-01-01T00:00:00Z') =>
  ({ id, work_rank, due_date, created_at });

describe('orderPersonalList', () => {
  it('puts the manager-ordered jobs first, by saved rank', () => {
    const items = [g('a', null), g('b', null), g('c', null)];
    const ranks = new Map([['c', 1], ['a', 2]]);
    expect(orderPersonalList(items, ranks, compareGraphicsDefault).map(i => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('orders unplaced jobs by the fallback (shared work order, then due date)', () => {
    const items = [g('due-late', null, '2026-10-09'), g('shared-2', 2), g('due-soon', null, '2026-10-01'), g('shared-1', 1)];
    expect(orderPersonalList(items, new Map(), compareGraphicsDefault).map(i => i.id))
      .toEqual(['shared-1', 'shared-2', 'due-soon', 'due-late']);
  });

  it('ignores saved ranks for jobs no longer on the list', () => {
    const items = [g('a', null), g('b', null)];
    const ranks = new Map([['gone', 1], ['b', 2]]);
    expect(orderPersonalList(items, ranks, compareGraphicsDefault).map(i => i.id)).toEqual(['b', 'a']);
  });

  it('gives two people independent orders for a shared job', () => {
    const items = [g('shared', null), g('x', null)];
    expect(orderPersonalList(items, new Map([['shared', 1], ['x', 2]]), compareGraphicsDefault)[0].id).toBe('shared');
    expect(orderPersonalList(items, new Map([['x', 1], ['shared', 2]]), compareGraphicsDefault)[0].id).toBe('x');
  });
});

describe('compareVehicleDefault', () => {
  it('sorts soonest promised-back first, undated last, then oldest check-in', () => {
    const v = (id: string, promised_back_date: string | null, created_at: string) => ({ id, promised_back_date, created_at });
    const list = [
      v('none-new', null, '2026-09-20'),
      v('late', '2026-10-05', '2026-09-01'),
      v('none-old', null, '2026-09-01'),
      v('soon', '2026-09-28', '2026-09-10'),
    ].sort(compareVehicleDefault);
    expect(list.map(x => x.id)).toEqual(['soon', 'late', 'none-old', 'none-new']);
  });
});

describe('sanitizeOrder', () => {
  it('keeps only jobs on the list, each once, in the order given', () => {
    expect(sanitizeOrder(['b', 'z', 'a', 'b'], new Set(['a', 'b']))).toEqual(['b', 'a']);
  });
});
