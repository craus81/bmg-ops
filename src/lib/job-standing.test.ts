import { describe, it, expect } from 'vitest';
import { jobStanding, compareJobStanding } from './job-standing';

const r = (verdict: 'reserved' | 'ready' | 'waiting' | 'short', extra: Partial<{ short: number; lastEta: string | null }> = {}) =>
  ({ verdict, covered: 0, onOrder: 0, short: 0, lastEta: null, ...extra });

describe('jobStanding', () => {
  it('honors cancelled and completed over parts', () => {
    expect(jobStanding({ status: 'cancelled' }, r('short', { short: 2 })).key).toBe('cancelled');
    expect(jobStanding({ status: 'completed' }, r('short', { short: 2 })).key).toBe('done');
  });

  it('reads a vehicle in the bay as In shop', () => {
    expect(jobStanding({ status: 'in_progress' }, r('ready')).label).toBe('In shop');
    expect(jobStanding({ status: 'scheduled_pickup' }).key).toBe('in_shop');
  });

  it('uses the parts verdict otherwise, whatever the hand-set status says', () => {
    expect(jobStanding({ status: 'parts_in_stock' }, r('short', { short: 1 }))).toMatchObject({ key: 'short', detail: '1 part short' });
    expect(jobStanding({ status: 'sold' }, r('short', { short: 3 })).detail).toBe('3 parts short');
    expect(jobStanding({ status: 'sold' }, r('waiting', { lastEta: '2026-10-24' }))).toMatchObject({ key: 'on_order', detail: 'ETA Oct 24' });
    expect(jobStanding({ status: 'sold' }, r('waiting')).detail).toBe('No ETA yet');
    expect(jobStanding({ status: 'sold' }, r('ready')).key).toBe('parts_in');
    expect(jobStanding({ status: 'sold' }, r('reserved')).detail).toBe('All parts reserved');
  });

  it('falls back to Sold with no verdict', () => {
    expect(jobStanding({ status: 'parts_ordered' }, null).key).toBe('sold');
    expect(jobStanding({ status: null }).key).toBe('sold');
  });
});

describe('compareJobStanding', () => {
  it('puts short jobs first and finished ones last', () => {
    const list = [
      jobStanding({ status: 'completed' }),
      jobStanding({ status: 'sold' }, r('ready')),
      jobStanding({ status: 'sold' }, r('short', { short: 1 })),
    ].sort(compareJobStanding);
    expect(list.map(s => s.key)).toEqual(['short', 'parts_in', 'done']);
  });
});
