import { describe, it, expect } from 'vitest';
import { applyBleed, nestElementsOnRoll, recalcFromPositions } from './nesting-algorithm';
import type { GraphicElement, ElementWithBleed } from './types';

function el(name: string, w: number, h: number): GraphicElement {
  return { element_name: name, element_type: 'decal', width_in: w, height_in: h, description: '' };
}

function withBleed(name: string, w: number, h: number, bleed = 0): ElementWithBleed {
  return applyBleed([el(name, w, h)], bleed)[0];
}

describe('applyBleed', () => {
  it('adds the bleed margin to both sides of each dimension', () => {
    const [result] = applyBleed([el('door-logo', 24, 18)], 0.25);
    expect(result.total_width_in).toBe(24.5);
    expect(result.total_height_in).toBe(18.5);
    expect(result.bleed_in).toBe(0.25);
    expect(result.element.width_in).toBe(24); // original untouched
  });
});

describe('nestElementsOnRoll', () => {
  it('returns an empty layout for no elements', () => {
    expect(nestElementsOnRoll([], 60)).toEqual({
      roll_width_in: 60,
      roll_length_in: 0,
      roll_area_sqft: 0,
      nested_elements: [],
      efficiency_pct: 0,
    });
  });

  it('places a single element at the origin', () => {
    const result = nestElementsOnRoll([withBleed('panel', 24, 24, 0.25)], 60);
    expect(result.nested_elements).toHaveLength(1);
    const placed = result.nested_elements[0];
    expect(placed.x_in).toBe(0);
    expect(placed.y_in).toBe(0);
    expect(result.roll_length_in).toBe(24.5);
    // 24.5×24.5 used of a 60×24.5 strip
    expect(result.efficiency_pct).toBe(40.8);
    expect(result.roll_area_sqft).toBeCloseTo((60 * 24.5) / 144, 5);
  });

  it('rotates a tall narrow element to minimize roll length', () => {
    // 10w × 50h fits both ways; laying it sideways uses 10" of roll
    const result = nestElementsOnRoll([withBleed('stripe', 10, 50)], 60);
    const placed = result.nested_elements[0];
    expect(placed.rotated).toBe(true);
    expect(placed.total_width_in).toBe(50);
    expect(placed.total_height_in).toBe(10);
    expect(result.roll_length_in).toBe(10);
  });

  it('cannot rotate an element taller than the roll is wide', () => {
    const result = nestElementsOnRoll([withBleed('banner', 10, 100)], 60);
    const placed = result.nested_elements[0];
    expect(placed.rotated).toBe(false);
    expect(result.roll_length_in).toBe(100);
  });

  it('stacks two 30×40 panels rotated, not side by side (greedy fit quirk)', () => {
    // Best-short-side-fit prefers the rotated 40-wide orientation (20" of
    // leftover width beats 30"), so the two panels stack end-to-end using
    // 60" of roll — even though placing them unrotated side by side would
    // use only 40". Characterized as current behavior, not as optimal.
    const result = nestElementsOnRoll(
      [withBleed('left', 30, 40), withBleed('right', 30, 40)],
      60
    );
    expect(result.nested_elements).toEqual([
      expect.objectContaining({ x_in: 0, y_in: 0, total_width_in: 40, total_height_in: 30, rotated: true }),
      expect.objectContaining({ x_in: 0, y_in: 30, total_width_in: 40, total_height_in: 30, rotated: true }),
    ]);
    expect(result.roll_length_in).toBe(60);
    expect(result.efficiency_pct).toBe(66.7);
  });

  it('skips elements that exceed the roll width in both orientations', () => {
    // 70×100 with one dim ≤ 60? No — but 70 > 60 and 100 > 60 triggers
    // panelization instead, so use panelization-exempt 61×1900 (length cap)
    const result = nestElementsOnRoll([withBleed('too-long', 61, 30)], 60, 25);
    // 61 wide can't fit normally; rotated it is 30×61 > 25 max length
    expect(result.nested_elements).toHaveLength(0);
    expect(result.roll_length_in).toBe(0);
  });

  it('panelizes elements that exceed roll width in both dimensions', () => {
    // 70×130: shorter side (70) splits into two 35" panels
    const result = nestElementsOnRoll([withBleed('wrap', 70, 130)], 60);
    expect(result.nested_elements).toHaveLength(2);
    const names = result.nested_elements.map((p) => p.element.element_name).sort();
    expect(names).toEqual(['wrap-1', 'wrap-2']);
    for (const p of result.nested_elements) {
      expect(Math.min(p.total_width_in, p.total_height_in)).toBeLessThanOrEqual(60);
    }
  });

  it('keeps bleed when panelizing', () => {
    const result = nestElementsOnRoll([withBleed('wrap', 70, 130, 0.5)], 60);
    for (const p of result.nested_elements) {
      expect(p.bleed_in).toBe(0.5);
    }
  });

  it('produces a deterministic layout for a realistic van-side kit', () => {
    const kit = [
      withBleed('driver-side', 55, 30, 0.25),
      withBleed('passenger-side', 55, 30, 0.25),
      withBleed('rear-door', 24, 36, 0.25),
      withBleed('hood', 30, 24, 0.25),
      withBleed('door-logo-1', 12, 12, 0.25),
      withBleed('door-logo-2', 12, 12, 0.25),
    ];
    const result = nestElementsOnRoll(kit, 60);
    expect(result.nested_elements).toHaveLength(6);
    // No overlaps
    const placed = result.nested_elements;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j];
        const overlap =
          a.x_in < b.x_in + b.total_width_in && a.x_in + a.total_width_in > b.x_in &&
          a.y_in < b.y_in + b.total_height_in && a.y_in + a.total_height_in > b.y_in;
        expect(overlap).toBe(false);
      }
    }
    // Everything inside the roll
    for (const p of placed) {
      expect(p.x_in + p.total_width_in).toBeLessThanOrEqual(60);
    }
    // Characterized output: total material used
    expect(result.roll_length_in).toBe(110);
    expect(result.efficiency_pct).toBe(80.9);
  });
});

describe('recalcFromPositions', () => {
  it('recomputes roll length and efficiency from manual positions', () => {
    const result = recalcFromPositions(
      [
        { element: el('a', 20, 20), bleed_in: 0, total_width_in: 20, total_height_in: 20, x_in: 0, y_in: 0 },
        { element: el('b', 20, 20), bleed_in: 0, total_width_in: 20, total_height_in: 20, x_in: 0, y_in: 30 },
      ],
      60
    );
    expect(result.roll_length_in).toBe(50);
    expect(result.efficiency_pct).toBe(26.7); // 800 of 3000 sq in
  });
});
