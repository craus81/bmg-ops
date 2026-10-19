import { describe, expect, it } from 'vitest';
import { fleetContentLine } from './graphics-fleet';

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
