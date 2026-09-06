import { describe, it, expect } from 'vitest';
import { visibleFrameRegion } from './viewfinder-crop';

describe('visibleFrameRegion', () => {
  it('at 1x the whole frame is visible whatever the box shape (letterboxed)', () => {
    // portrait frame in a taller portrait box
    expect(visibleFrameRegion(1440, 1920, 390, 640, 1)).toEqual({ sx: 0, sy: 0, sw: 1440, sh: 1920 });
    // landscape frame in a wide box (rotated phone)
    expect(visibleFrameRegion(1920, 1440, 800, 300, 1)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1440 });
  });

  it('at 2x a frame that exactly fills the box shows its centre half', () => {
    const r = visibleFrameRegion(1600, 1200, 400, 300, 2);
    expect(r).toEqual({ sx: 400, sy: 300, sw: 800, sh: 600 });
  });

  it('zoomed crop takes the box shape once both axes overflow', () => {
    // 4:3 frame letterboxed in a 9:16 box: at 1x width is the limiting axis.
    const r = visibleFrameRegion(1440, 1920, 390, 693, 3);
    // scale = min(390/1440, 693/1920) * 3 = 0.2708*3 = 0.8125
    expect(r.sw).toBeCloseTo(390 / 0.8125, 3);
    expect(r.sh).toBeCloseTo(693 / 0.8125, 3);
    expect(r.sw / r.sh).toBeCloseTo(390 / 693, 5);
    expect(r.sx).toBeCloseTo((1440 - r.sw) / 2, 5);
    expect(r.sy).toBeCloseTo((1920 - r.sh) / 2, 5);
  });

  it('never returns a region larger than the frame', () => {
    const r = visibleFrameRegion(1920, 1440, 800, 300, 1.2);
    expect(r.sw).toBeLessThanOrEqual(1920);
    expect(r.sh).toBeLessThanOrEqual(1440);
    expect(r.sx).toBeGreaterThanOrEqual(0);
    expect(r.sy).toBeGreaterThanOrEqual(0);
  });

  it('treats zoom below 1 or non-finite as 1x, and degenerate sizes as the whole frame', () => {
    expect(visibleFrameRegion(100, 50, 10, 10, 0.5)).toEqual(visibleFrameRegion(100, 50, 10, 10, 1));
    expect(visibleFrameRegion(100, 50, 10, 10, NaN)).toEqual(visibleFrameRegion(100, 50, 10, 10, 1));
    expect(visibleFrameRegion(100, 50, 0, 10, 2)).toEqual({ sx: 0, sy: 0, sw: 100, sh: 50 });
  });
});
