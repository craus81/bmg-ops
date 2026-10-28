import { describe, it, expect } from 'vitest';
import { scheduleStep } from './job-schedule-alerts-state';

describe('scheduleStep', () => {
  it('asks to reserve when every part is in stock but not reserved', () => {
    expect(scheduleStep({ status: 'sold' }, 'ready')).toBe('reserve');
  });

  it('asks to schedule when every part is reserved and there is no drop-off date', () => {
    expect(scheduleStep({ status: 'sold', customer_dropoff_date: null }, 'reserved')).toBe('schedule');
  });

  it('is done once a drop-off date is set', () => {
    expect(scheduleStep({ status: 'sold', customer_dropoff_date: '2026-11-02' }, 'reserved')).toBeNull();
  });

  it('waits while parts are short or on order', () => {
    expect(scheduleStep({ status: 'sold' }, 'short')).toBeNull();
    expect(scheduleStep({ status: 'sold' }, 'waiting')).toBeNull();
    expect(scheduleStep({ status: 'sold' }, null)).toBeNull();
  });

  it('skips jobs already in the shop, done, or cancelled', () => {
    for (const status of ['in_progress', 'scheduled_pickup', 'completed', 'cancelled']) {
      expect(scheduleStep({ status }, 'ready')).toBeNull();
      expect(scheduleStep({ status }, 'reserved')).toBeNull();
    }
  });
});
