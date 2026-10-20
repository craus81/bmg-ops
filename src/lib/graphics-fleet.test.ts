import { describe, expect, it } from 'vitest';
import { fleetContentLine, jobCoversEstimate } from './graphics-fleet';

describe('fleetContentLine', () => {
  it('names every unit for the print team', () => {
    expect(fleetContentLine(['101', '102', '103'])).toBe(
      'Fleet order, 3 kits: units 101, 102, 103. Same graphics on each, only the unit number changes.',
    );
  });

  it('still counts kits whose unit number is missing', () => {
    expect(fleetContentLine(['7', null])).toBe(
      'Fleet order, 2 kits: unit 7. Same graphics on each, only the unit number changes.',
    );
  });
});

describe('jobCoversEstimate', () => {
  it('covers its own estimate and every estimate of its fleet order', () => {
    expect(jobCoversEstimate({ estimate_id: 'e1', fleet_group_id: null }, { id: 'e1' })).toBe(true);
    expect(jobCoversEstimate({ estimate_id: 'e1', fleet_group_id: 'g' }, { id: 'e2', fleet_group_id: 'g' })).toBe(true);
    expect(jobCoversEstimate({ estimate_id: 'e1', fleet_group_id: 'g' }, { id: 'e2', fleet_group_id: 'other' })).toBe(false);
    expect(jobCoversEstimate({ estimate_id: 'e1', fleet_group_id: null }, { id: 'e2', fleet_group_id: null })).toBe(false);
  });
});
