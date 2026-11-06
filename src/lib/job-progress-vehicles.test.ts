import { describe, expect, it } from 'vitest';
import { checkinNearOrder, normVin, vehicleBelongsElsewhere, vehicleLabel } from './job-progress-server';

describe('job progress: matching vans to orders', () => {
  it('only full 17-character VINs match, any case', () => {
    expect(normVin(' 1ftbr1y8xpka12345 ')).toBe('1FTBR1Y8XPKA12345');
    expect(normVin('A12345')).toBeNull();
    expect(normVin(null)).toBeNull();
  });

  it('a van checked in for another order is not this one', () => {
    expect(vehicleBelongsElsewhere({ source_estimate_id: 'other' }, 'est', [])).toBe(true);
    expect(vehicleBelongsElsewhere({ netsuite_sales_order_id: '900' }, 'est', [{ netsuite_id: 901 }])).toBe(true);
    expect(vehicleBelongsElsewhere({ netsuite_sales_order_id: '901' }, 'est', [{ netsuite_id: 901 }])).toBe(false);
    expect(vehicleBelongsElsewhere({ source_estimate_id: 'est' }, 'est', [])).toBe(false);
    expect(vehicleBelongsElsewhere({}, 'est', [])).toBe(false);
  });

  it('a VIN match only counts for a visit around the time of the order', () => {
    expect(checkinNearOrder('2026-11-05T13:00:00Z', '2026-10-20T15:00:00Z')).toBe(true);
    expect(checkinNearOrder('2026-10-01T13:00:00Z', '2026-10-20T15:00:00Z')).toBe(true);
    expect(checkinNearOrder('2026-06-01T13:00:00Z', '2026-10-20T15:00:00Z')).toBe(false);
    expect(checkinNearOrder(null, '2026-10-20T15:00:00Z')).toBe(false);
  });

  it('labels the van by year, make, model and VIN tail', () => {
    expect(vehicleLabel({ vehicle_year: 2025, vehicle_make: 'Ford', vehicle_model: 'Transit', vin: '1FTBR1Y8XPKA12345' })).toBe('2025 Ford Transit · VIN …A12345');
    expect(vehicleLabel({ vin: null })).toBe('Vehicle');
  });
});
