import { describe, it, expect } from 'vitest';
import { graphicsJobQuantity } from './graphics-job-quantity';

describe('graphicsJobQuantity', () => {
  it('keeps whole counts', () => {
    expect(graphicsJobQuantity(1)).toBe(1);
    expect(graphicsJobQuantity(4)).toBe(4);
    expect(graphicsJobQuantity('3')).toBe(3);
  });

  it('treats a square-foot amount as one job', () => {
    expect(graphicsJobQuantity(293.2)).toBe(1);
    expect(graphicsJobQuantity('466.8')).toBe(1);
  });

  it('falls back to 1 for empty, zero, negative or junk', () => {
    expect(graphicsJobQuantity(null)).toBe(1);
    expect(graphicsJobQuantity(undefined)).toBe(1);
    expect(graphicsJobQuantity(0)).toBe(1);
    expect(graphicsJobQuantity(-2)).toBe(1);
    expect(graphicsJobQuantity('abc')).toBe(1);
  });
});
