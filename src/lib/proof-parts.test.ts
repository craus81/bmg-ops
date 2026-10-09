import { describe, it, expect } from 'vitest';
import type { CoverageBox, PhotoProof } from './coverage-proof';
import { badgeSpots, partKey, partRowsForPage, proofParts, withPartSize } from './proof-parts';

let seq = 0;
const box = (over: Partial<CoverageBox> = {}): CoverageBox => ({
  id: `b${++seq}`, label: 'Logo', color: '#06b6d4',
  rect: { x: 0, y: 0, w: 100, h: 50 },
  ...over,
});
const page = (boxes: CoverageBox[], id = 'p1'): PhotoProof => ({ id, path: `${id}.jpg`, label: '', boxes });

describe('partKey', () => {
  it('ignores case, punctuation and which side a piece goes on', () => {
    expect(partKey('Central Air logo (door)')).toBe(partKey('central air LOGO (door)'));
    expect(partKey('Logo (driver side)')).toBe(partKey('Logo (passenger side)'));
    expect(partKey('Logo - DS')).toBe(partKey('Logo - PS'));
    expect(partKey('Left door logo')).toBe(partKey('Right door logo'));
  });

  it('keeps what the piece is', () => {
    expect(partKey('Door logo')).not.toBe(partKey('Tailgate logo'));
    expect(partKey('CENTRALAIRSTL.COM (bed side)')).toContain('centralairstl.com');
  });
});

describe('proofParts', () => {
  it('gives matching pieces one number and one averaged size', () => {
    const a = box({ label: 'Central Air logo (door)', width_in: 33.2, height_in: 23.8, area_in2: 33.2 * 23.8, rect: { x: 0, y: 0, w: 100, h: 70 } });
    const b = box({ label: 'Central Air logo (door)', width_in: 33.3, height_in: 25.0, area_in2: 33.3 * 25, rect: { x: 0, y: 300, w: 100, h: 70 } });
    const idx = proofParts([page([a, b])]);
    expect(idx.parts).toHaveLength(1);
    expect(idx.partOf.get(a.id)!.number).toBe(1);
    expect(idx.partOf.get(b.id)!.number).toBe(1);
    expect(idx.sizeOf.get(a.id)).toMatchObject({ width_in: 33.3, height_in: 24.4 });
    expect(idx.sizeOf.get(b.id)).toMatchObject({ width_in: 33.3, height_in: 24.4 });
    expect(withPartSize(a, idx).width_in).toBe(33.3);
  });

  it('lets a printed or typed size win over the drawing', () => {
    const drawn = box({ width_in: 33.2, height_in: 23.8 });
    const printed = box({ width_in: 33, height_in: 24, manual: true, rect: { x: 0, y: 300, w: 100, h: 50 } });
    const idx = proofParts([page([drawn, printed])]);
    expect(idx.sizeOf.get(drawn.id)).toMatchObject({ width_in: 33, height_in: 24 });
  });

  it('keeps same-named pieces of very different sizes apart', () => {
    const big = box({ width_in: 40, height_in: 20 });
    const small = box({ width_in: 12, height_in: 6, rect: { x: 0, y: 300, w: 100, h: 50 } });
    const idx = proofParts([page([big, small])]);
    expect(idx.parts.map(p => p.number)).toEqual([1, 2]);
    expect(withPartSize(small, idx)).toBe(small);
    expect(idx.partOf.get(small.id)!.size).toMatchObject({ width_in: 12, height_in: 6 });
  });

  it('keeps pieces on different films apart', () => {
    const a = box({ width_in: 10, height_in: 10, substrate_id: 'cast' });
    const b = box({ width_in: 10, height_in: 10, substrate_id: 'perf', rect: { x: 0, y: 300, w: 100, h: 50 } });
    expect(proofParts([page([a, b])]).parts).toHaveLength(2);
  });

  it('leaves a lone piece at its exact size', () => {
    const a = box({ width_in: 33.24, height_in: 23.81, area_in2: 790 });
    const idx = proofParts([page([a])]);
    expect(withPartSize(a, idx)).toBe(a);
  });

  it('numbers in reading order across pages, whatever order they were drawn', () => {
    const right = box({ label: 'B', rect: { x: 500, y: 10, w: 50, h: 50 } });
    const left = box({ label: 'A', rect: { x: 10, y: 20, w: 50, h: 50 } });
    const below = box({ label: 'C', rect: { x: 0, y: 400, w: 50, h: 50 } });
    const page2 = box({ label: 'A', rect: { x: 900, y: 0, w: 50, h: 50 } });
    const idx = proofParts([page([below, right, left]), page([page2], 'p2')]);
    expect(idx.partOf.get(left.id)!.number).toBe(1);
    expect(idx.partOf.get(right.id)!.number).toBe(2);
    expect(idx.partOf.get(below.id)!.number).toBe(3);
    expect(idx.partOf.get(page2.id)!.number).toBe(1);
  });

  it('never merges unnamed boxes and leaves unsized ones unpriced', () => {
    const a = box({ label: '' });
    const b = box({ label: '', rect: { x: 0, y: 300, w: 100, h: 50 } });
    const idx = proofParts([page([a, b])]);
    expect(idx.parts).toHaveLength(2);
    expect(idx.sizeOf.size).toBe(0);
  });
});

describe('partRowsForPage', () => {
  it('lists each part once with its count on the page', () => {
    const a = box({ label: 'Door logo', width_in: 30, height_in: 20 });
    const b = box({ label: 'Door logo', width_in: 30.4, height_in: 20, rect: { x: 0, y: 300, w: 100, h: 50 } });
    const c = box({ label: 'Phone', width_in: 59, height_in: 3.5, qty: 2, rect: { x: 0, y: 600, w: 100, h: 50 } });
    const idx = proofParts([page([a, b, c])]);
    const rows = partRowsForPage([a, b, c], idx, () => 'Cast');
    expect(rows).toEqual([
      { number: 1, name: 'Door logo', size: '30.2" × 20"', film: 'Cast', qty: 2 },
      { number: 2, name: 'Phone', size: '59" × 3.5"', film: 'Cast', qty: 2 },
    ]);
  });
});

describe('badgeSpots', () => {
  it('puts the number beside its piece, clear of other pieces', () => {
    const a = box({ rect: { x: 100, y: 100, w: 100, h: 100 } });
    const [s] = badgeSpots([a], () => 1, 1000, 1000, 10);
    expect(s.x).toBeLessThan(100);
    expect(s.y).toBe(150);
  });

  it('moves to the other side when the left is off the picture or taken', () => {
    const edge = box({ rect: { x: 0, y: 100, w: 100, h: 100 } });
    const [s] = badgeSpots([edge], () => 1, 1000, 1000, 10);
    expect(s.x).toBeGreaterThan(100);
    const blocker = box({ rect: { x: 300, y: 100, w: 95, h: 100 } });
    const target = box({ rect: { x: 400, y: 100, w: 100, h: 100 } });
    const spots = badgeSpots([target, blocker], () => 1, 1000, 1000, 10);
    expect(spots[0].x).toBeGreaterThan(500);
  });
});
