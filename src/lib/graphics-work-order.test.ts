import { describe, it, expect } from 'vitest';
import {
  rankedQueue, workOrderPositions, compareByDueDate, unrankedPool,
  type RankableJob,
} from './graphics-work-order';
import type { GraphicsJobStatus } from './types';

const job = (
  id: string,
  work_rank: number | null,
  status: GraphicsJobStatus = 'designing',
  due_date: string | null = null,
  created_at = '2026-01-01T00:00:00Z',
) => ({ id, work_rank, status, due_date, created_at });

describe('rankedQueue', () => {
  it('orders by the stored rank, not by input order', () => {
    const jobs = [job('c', 3), job('a', 1), job('b', 2)];
    expect(rankedQueue(jobs).map(j => j.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves unranked jobs out entirely', () => {
    const jobs = [job('a', 1), job('b', null), job('c', 2)];
    expect(rankedQueue(jobs).map(j => j.id)).toEqual(['a', 'c']);
  });

  it('drops jobs that finished while still ranked', () => {
    const jobs = [job('a', 1, 'installed'), job('b', 2), job('c', 3, 'cancelled'), job('d', 4, 'shipped')];
    expect(rankedQueue(jobs).map(j => j.id)).toEqual(['b']);
  });
});

describe('workOrderPositions', () => {
  it('numbers from 1 with no gaps', () => {
    const jobs = [job('a', 1), job('b', 2), job('c', 3)];
    expect([...workOrderPositions(jobs)]).toEqual([['a', 1], ['b', 2], ['c', 3]]);
  });

  it('closes the hole a finished job leaves in the stored block', () => {
    // The board must never open on a list that starts at #2.
    const jobs = [job('done', 1, 'shipped'), job('a', 2), job('b', 4)];
    const pos = workOrderPositions(jobs);
    expect(pos.get('a')).toBe(1);
    expect(pos.get('b')).toBe(2);
    expect(pos.has('done')).toBe(false);
  });

  it('gives unranked jobs no position at all', () => {
    const pos = workOrderPositions([job('a', null), job('b', null)]);
    expect(pos.size).toBe(0);
  });
});

describe('compareByDueDate', () => {
  const sortIds = (jobs: ReturnType<typeof job>[]) => [...jobs].sort(compareByDueDate).map(j => j.id);

  it('puts the soonest due date first', () => {
    expect(sortIds([
      job('late', null, 'designing', '2026-03-10'),
      job('soon', null, 'designing', '2026-03-01'),
    ])).toEqual(['soon', 'late']);
  });

  it('sorts undated jobs last in either input order', () => {
    expect(sortIds([
      job('none', null, 'designing', null),
      job('dated', null, 'designing', '2026-03-01'),
    ])).toEqual(['dated', 'none']);
    expect(sortIds([
      job('dated', null, 'designing', '2026-03-01'),
      job('none', null, 'designing', null),
    ])).toEqual(['dated', 'none']);
  });

  it('ignores the time part of a timestamp due date', () => {
    expect(compareByDueDate(
      { due_date: '2026-03-01T23:00:00.000Z', created_at: '2026-01-01' },
      { due_date: '2026-03-01', created_at: '2026-01-01' },
    )).toBe(0);
  });

  it('breaks a due-date tie on creation order', () => {
    expect(sortIds([
      job('newer', null, 'designing', '2026-03-01', '2026-02-02T00:00:00Z'),
      job('older', null, 'designing', '2026-03-01', '2026-02-01T00:00:00Z'),
    ])).toEqual(['older', 'newer']);
  });
});

describe('unrankedPool', () => {
  it('offers only workable jobs that are not already on the list', () => {
    const jobs = [
      job('ranked', 1, 'designing', '2026-03-01'),
      job('finished', null, 'installed', '2026-03-02'),
      job('open', null, 'printing', '2026-03-03'),
    ];
    const pool = unrankedPool(jobs, new Set(['ranked']));
    expect(pool.map(j => j.id)).toEqual(['open']);
  });

  it('offers the soonest-due job first', () => {
    const jobs = [
      job('c', null, 'designing', null),
      job('b', null, 'designing', '2026-03-05'),
      job('a', null, 'designing', '2026-03-01'),
    ];
    expect(unrankedPool(jobs, new Set()).map(j => j.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the array it was handed', () => {
    const jobs: RankableJob[] = [job('b', null), job('a', null)];
    const before = jobs.map(j => j.id);
    unrankedPool(jobs as any, new Set());
    expect(jobs.map(j => j.id)).toEqual(before);
  });
});
