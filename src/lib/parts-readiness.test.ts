import { describe, it, expect } from 'vitest';
import { allocationMath } from './parts-readiness';

// The whole point of allocations: two jobs can't count the same shelf
// stock. Pin the pool math so a refactor can't quietly double-count.
describe('allocationMath', () => {
  it('fully reserved part is reserved regardless of the pool', () => {
    const m = allocationMath({ needed: 3, availPool: 0, allocatedHere: 3, allocatedOthers: 0, onOrder: 0 });
    expect(m.state).toBe('reserved');
    expect(m.short).toBe(0);
    expect(m.allocatable).toBe(0);
  });

  it('free stock covers the need → available, and allocatable tops up to needed', () => {
    const m = allocationMath({ needed: 4, availPool: 10, allocatedHere: 1, allocatedOthers: 2, onOrder: 0 });
    // pool 10 − mine 1 − others 2 = 7 free; usable = 1 + 7 = 8
    expect(m.free).toBe(7);
    expect(m.usable).toBe(8);
    expect(m.state).toBe('available');
    expect(m.allocatable).toBe(3); // needed 4 − mine 1
  });

  it("another job's reservation removes stock from my pool", () => {
    const m = allocationMath({ needed: 4, availPool: 5, allocatedHere: 0, allocatedOthers: 5, onOrder: 0 });
    expect(m.free).toBe(0);
    expect(m.usable).toBe(0);
    expect(m.short).toBe(4);
    expect(m.state).toBe('short');
  });

  it('on-order quantity turns short into waiting', () => {
    const m = allocationMath({ needed: 6, availPool: 2, allocatedHere: 0, allocatedOthers: 0, onOrder: 4 });
    expect(m.usable).toBe(2);
    expect(m.short).toBe(0);
    expect(m.state).toBe('waiting');
  });

  it('allocatable never exceeds free stock', () => {
    const m = allocationMath({ needed: 10, availPool: 3, allocatedHere: 0, allocatedOthers: 1, onOrder: 0 });
    expect(m.free).toBe(2);
    expect(m.allocatable).toBe(2);
  });

  it('over-reservation beyond the pool clamps free at zero without going negative', () => {
    const m = allocationMath({ needed: 2, availPool: 3, allocatedHere: 2, allocatedOthers: 4, onOrder: 0 });
    expect(m.free).toBe(0);
    expect(m.state).toBe('reserved'); // my 2 are held even though the pool is oversubscribed
  });

  it('zero-need line never reads as reserved', () => {
    const m = allocationMath({ needed: 0, availPool: 5, allocatedHere: 0, allocatedOthers: 0, onOrder: 0 });
    expect(m.state).toBe('available');
    expect(m.allocatable).toBe(0);
  });
});
