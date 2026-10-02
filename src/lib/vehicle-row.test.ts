import { describe, it, expect } from 'vitest';
import { vehicleRowKey, vehicleDoneChecks } from './types';
import { deptOfStage } from './shop-labor';

describe('vehicleRowKey (one-line status)', () => {
  it('uses the real status outside in_progress', () => {
    expect(vehicleRowKey({ status: 'received', shop_stage: 'upfit' })).toBe('received');
    expect(vehicleRowKey({ status: 'checked_in' })).toBe('received');
    expect(vehicleRowKey({ status: 'complete', shop_stage: 'graphics' })).toBe('complete');
    expect(vehicleRowKey({ status: 'shipped' })).toBe('shipped');
  });
  it('uses the shop stage while in_progress', () => {
    expect(vehicleRowKey({ status: 'in_progress', shop_stage: 'graphics_complete' })).toBe('graphics_complete');
    expect(vehicleRowKey({ status: 'in_progress', shop_stage: 'upfit_complete' })).toBe('upfit_complete');
  });
  it('maps legacy rows with no stage', () => {
    expect(vehicleRowKey({ status: 'in_progress', shop_stage: null })).toBe('upfit');
    expect(vehicleRowKey({ status: 'stuck_parts' })).toBe('upfit');
    expect(vehicleRowKey({ status: 'stuck_graphics' })).toBe('graphics');
  });
});

describe('vehicleDoneChecks', () => {
  it('keeps both checks independent of the current button', () => {
    expect(vehicleDoneChecks({ graphics_install_status: 'complete', upfit_completed_at: null })).toEqual({ graphics: true, upfit: false });
    expect(vehicleDoneChecks({ graphics_install_status: 'in_progress', upfit_completed_at: '2026-10-02T12:00:00Z' })).toEqual({ graphics: false, upfit: true });
  });
});

describe('deptOfStage', () => {
  it('bills graphics stages to graphics and everything else to upfit', () => {
    expect(deptOfStage('graphics')).toBe('graphics');
    expect(deptOfStage('graphics_complete')).toBe('graphics');
    expect(deptOfStage('upfit')).toBe('upfit');
    expect(deptOfStage(null)).toBe('upfit');
  });
});
