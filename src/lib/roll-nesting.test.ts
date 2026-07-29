import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ROLL,
  NestPiece,
  PlacementMap,
  RollConfig,
  computeUsage,
  findLayoutIssues,
  fmtFtIn,
  offsetArea,
  packPieces,
  partLetter,
  placedRect,
  polygonArea,
  polygonPerimeter,
  polygonSelfIntersects,
  reconcilePlacements,
  splitForRoll,
} from './roll-nesting';

const piece = (key: string, w: number, h: number, filmKey = 'f1'): NestPiece =>
  ({ key, filmKey, name: key, w, h, set: 0, copy: 0, part: '' });

const cfg: RollConfig = { widthIn: 58.5, lengthIn: 1800, spacingIn: 0.5, edgeMarginIn: 0.5, overlapIn: 0.5 };

// Every pair of placed pieces on the same film+roll must be separated by at
// least the configured spacing (checked by inflating one rect by spacing).
function assertSpacingRespected(pieces: NestPiece[], placements: PlacementMap, config: RollConfig) {
  const placed = pieces.filter(p => placements[p.key]);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      const pa = placements[a.key], pb = placements[b.key];
      if (a.filmKey !== b.filmKey || pa.roll !== pb.roll) continue;
      const ra = placedRect(a, pa), rb = placedRect(b, pb);
      const gapOk =
        ra.x + ra.w + config.spacingIn <= rb.x + 1e-6 ||
        rb.x + rb.w + config.spacingIn <= ra.x + 1e-6 ||
        ra.y + ra.h + config.spacingIn <= rb.y + 1e-6 ||
        rb.y + rb.h + config.spacingIn <= ra.y + 1e-6;
      expect(gapOk, `${a.key} and ${b.key} closer than spacing`).toBe(true);
    }
  }
}

function assertInBounds(pieces: NestPiece[], placements: PlacementMap, config: RollConfig) {
  for (const p of pieces) {
    const pl = placements[p.key];
    if (!pl) continue;
    const r = placedRect(p, pl);
    expect(r.x).toBeGreaterThanOrEqual(config.edgeMarginIn - 1e-6);
    expect(r.y).toBeGreaterThanOrEqual(config.edgeMarginIn - 1e-6);
    expect(r.x + r.w).toBeLessThanOrEqual(config.lengthIn - config.edgeMarginIn + 1e-6);
    expect(r.y + r.h).toBeLessThanOrEqual(config.widthIn - config.edgeMarginIn + 1e-6);
  }
}

describe('packPieces', () => {
  it('places a single piece at the margin corner', () => {
    const p = [piece('a', 20, 10)];
    const { placements, unplaced } = packPieces(p, cfg);
    expect(unplaced).toHaveLength(0);
    expect(placements['a']).toBeTruthy();
    expect(placements['a'].x).toBeCloseTo(0.5);
    expect(placements['a'].y).toBeCloseTo(0.5);
  });

  it('rotates a piece that only fits across the roll the other way', () => {
    // 100" long × 50" wide fits; 50 across is fine either way, but a piece
    // 58" × 20" placed with 58 across (> 57.5 usable) must rotate.
    const p = [piece('a', 20, 58)];
    const { placements, unplaced } = packPieces(p, cfg);
    expect(unplaced).toHaveLength(0);
    const r = placedRect(p[0], placements['a']);
    expect(r.h).toBeLessThanOrEqual(cfg.widthIn - 2 * cfg.edgeMarginIn + 1e-6);
    assertInBounds(p, placements, cfg);
  });

  it('prefers the orientation that grows the roll least', () => {
    const p = [piece('a', 30, 10)];
    const { placements } = packPieces(p, cfg);
    // 10 along the roll, 30 across beats 30 along.
    const r = placedRect(p[0], placements['a']);
    expect(r.w).toBeCloseTo(10);
    expect(r.h).toBeCloseTo(30);
  });

  it('reports pieces too big for the roll instead of placing them', () => {
    const p = [piece('a', 60, 60)]; // > usable width in both orientations
    const { placements, unplaced } = packPieces(p, cfg);
    expect(unplaced.map(u => u.key)).toEqual(['a']);
    expect(placements['a']).toBeUndefined();
  });

  it('packs many pieces without overlap, respecting spacing', () => {
    const pieces: NestPiece[] = [];
    for (let i = 0; i < 40; i++) pieces.push(piece(`p${i}`, 10 + (i % 5) * 7, 8 + (i % 3) * 11));
    const { placements, unplaced } = packPieces(pieces, cfg);
    expect(unplaced).toHaveLength(0);
    assertSpacingRespected(pieces, placements, cfg);
    assertInBounds(pieces, placements, cfg);
    const issues = findLayoutIssues(pieces, placements, cfg);
    expect(issues.overlapping.size).toBe(0);
    expect(issues.outOfBounds.size).toBe(0);
  });

  it('overflows onto a second roll when the length runs out', () => {
    const short: RollConfig = { ...cfg, lengthIn: 100 };
    // Each piece takes 40" of length across nearly the full width; three
    // fit two-per-roll at most (40 + 0.5 + 40 + margins > 100? 0.5+40+0.5+40+0.5 = 81.5 ok,
    // a third needs 122 > 100) — so roll 2 must open.
    const pieces = [piece('a', 40, 50), piece('b', 40, 50), piece('c', 40, 50)];
    const { placements, unplaced } = packPieces(pieces, short);
    expect(unplaced).toHaveLength(0);
    const rolls = new Set(Object.values(placements).map(pl => pl.roll));
    expect(rolls.size).toBe(2);
    assertInBounds(pieces, placements, short);
    assertSpacingRespected(pieces, placements, short);
  });

  it('keeps films on separate rolls', () => {
    const pieces = [piece('a', 10, 10, 'film-a'), piece('b', 10, 10, 'film-b')];
    const { placements } = packPieces(pieces, cfg);
    // Both can sit at the same coordinates because they're different rolls.
    expect(placements['a'].roll).toBe(0);
    expect(placements['b'].roll).toBe(0);
    const issues = findLayoutIssues(pieces, placements, cfg);
    expect(issues.overlapping.size).toBe(0);
  });

  it('packs around existing placements without moving them', () => {
    const fixed = piece('fixed', 30, 30);
    const fixedPl = { roll: 0, x: 0.5, y: 0.5, rot: 0 as const };
    const incoming = [piece('new1', 20, 20), piece('new2', 20, 20)];
    const { placements, unplaced } = packPieces(incoming, cfg, [{ piece: fixed, placement: fixedPl }]);
    expect(unplaced).toHaveLength(0);
    const all = [fixed, ...incoming];
    const merged: PlacementMap = { fixed: fixedPl, ...placements };
    const issues = findLayoutIssues(all, merged, cfg);
    expect(issues.overlapping.size).toBe(0);
    assertSpacingRespected(all, merged, cfg);
  });
});

describe('reconcilePlacements', () => {
  it('returns the same object when nothing changed', () => {
    const pieces = [piece('a', 10, 10)];
    const { placements } = packPieces(pieces, cfg);
    expect(reconcilePlacements(pieces, placements, cfg)).toBe(placements);
  });

  it('packs new pieces around existing ones without moving them', () => {
    const pieces = [piece('a', 10, 10), piece('b', 12, 12)];
    const { placements } = packPieces(pieces, cfg);
    const next = [pieces[0], pieces[1], piece('c', 14, 14)];
    const merged = reconcilePlacements(next, placements, cfg);
    expect(merged['a']).toEqual(placements['a']); // untouched
    expect(merged['c']).toBeTruthy();
    const issues = findLayoutIssues(next, merged, cfg);
    expect(issues.overlapping.size).toBe(0);
  });

  it('keeps placements for temporarily missing pieces so they survive a round-trip', () => {
    // Retyping "12" sets → "1" → "12" must not wipe the manual layout.
    const pieces = [piece('a', 10, 10), piece('b', 12, 12)];
    const { placements } = packPieces(pieces, cfg);
    const shrunk = reconcilePlacements([pieces[0]], placements, cfg);
    expect(shrunk['b']).toEqual(placements['b']); // retained, inert
    const restored = reconcilePlacements(pieces, shrunk, cfg);
    expect(restored['b']).toEqual(placements['b']);
    expect(restored['a']).toEqual(placements['a']);
  });

  it('returns the same object when the only missing pieces are unplaceable', () => {
    const pieces = [piece('a', 10, 10), piece('big', 70, 70)];
    const { placements } = packPieces([pieces[0]], cfg);
    const r1 = reconcilePlacements(pieces, placements, cfg);
    expect(r1).toBe(placements);
  });

  it('ignores stale placements when packing (they are not obstacles)', () => {
    const stale: PlacementMap = { ghost: { roll: 0, x: 0.5, y: 0.5, rot: 0 } };
    const pieces = [piece('a', 20, 20)];
    const merged = reconcilePlacements(pieces, stale, cfg);
    // 'a' may land exactly where the ghost sat — the ghost isn't real.
    expect(merged['a']).toBeTruthy();
    expect(merged['a'].x).toBeCloseTo(0.5);
    expect(merged['a'].y).toBeCloseTo(0.5);
  });
});

describe('splitForRoll', () => {
  it('leaves pieces that fit alone', () => {
    expect(splitForRoll(40, 80, cfg)).toEqual([{ w: 40, h: 80, partIndex: -1 }]);
  });

  it('splits an oversized panel into strips that fit, with seam overlap', () => {
    // 60" × 200" box-truck side: 60 > 57.5 usable in both orientations.
    const parts = splitForRoll(60, 200, cfg);
    expect(parts).toHaveLength(2);
    for (const p of parts) {
      expect(Math.min(p.w, p.h)).toBeLessThanOrEqual(57.5 + 1e-9);
      expect(p.h).toBe(200);
    }
    // n·x − (n−1)·overlap = 60 → strips cover the panel plus one seam.
    const totalW = parts.reduce((s, p) => s + p.w, 0);
    expect(totalW).toBeCloseTo(60 + 0.5);
    expect(parts.map(p => p.partIndex)).toEqual([0, 1]);
  });

  it('splits very wide panels into more strips', () => {
    const parts = splitForRoll(170, 200, cfg);
    expect(parts.length).toBe(3);
    for (const p of parts) expect(p.w).toBeLessThanOrEqual(57.5 + 1e-9);
    expect(parts.reduce((s, p) => s + p.w, 0)).toBeCloseTo(170 + 2 * 0.5);
  });

  it('split pieces actually pack onto the roll', () => {
    const parts = splitForRoll(60, 200, cfg);
    const pieces = parts.map((p, i) => ({ ...piece(`s${i}`, p.w, p.h), part: partLetter(p.partIndex) }));
    const { unplaced } = packPieces(pieces, cfg);
    expect(unplaced).toHaveLength(0);
  });
});

describe('polygonSelfIntersects', () => {
  it('accepts simple shapes', () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const lShape = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }];
    expect(polygonSelfIntersects(square)).toBe(false);
    expect(polygonSelfIntersects(lShape)).toBe(false);
  });

  it('flags a bowtie', () => {
    const bowtie = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    expect(polygonSelfIntersects(bowtie)).toBe(true);
  });
});

describe('computeUsage', () => {
  it('bills roll width × used length including the trailing margin', () => {
    const pieces = [piece('a', 20, 10)];
    const { placements } = packPieces(pieces, cfg);
    const usage = computeUsage(pieces, placements, cfg);
    expect(usage.films).toHaveLength(1);
    const f = usage.films[0];
    // Placed 10 along the roll (rotated) at x=0.5 → used = 0.5+10+0.5 = 11".
    expect(f.rolls[0].usedLengthIn).toBeCloseTo(11);
    expect(f.rollSqft).toBeCloseTo((11 * 58.5) / 144);
    expect(f.graphicSqft).toBeCloseTo((20 * 10) / 144);
    expect(usage.totalRollSqft).toBeCloseTo(f.rollSqft);
  });

  it('sums usage across rolls and reports unplaced pieces', () => {
    const short: RollConfig = { ...cfg, lengthIn: 100 };
    const pieces = [piece('a', 40, 50), piece('b', 40, 50), piece('c', 40, 50), piece('big', 70, 70)];
    const { placements } = packPieces(pieces, short);
    const usage = computeUsage(pieces, placements, short);
    expect(usage.unplaced.map(p => p.key)).toEqual(['big']);
    const f = usage.films[0];
    expect(f.rolls).toHaveLength(2);
    expect(f.rollSqft).toBeCloseTo(f.rolls.reduce((s, r) => s + (r.usedLengthIn * 58.5) / 144, 0));
  });
});

describe('findLayoutIssues', () => {
  it('flags overlapping and out-of-bounds pieces after manual moves', () => {
    const pieces = [piece('a', 10, 10), piece('b', 10, 10), piece('c', 10, 10)];
    const placements: PlacementMap = {
      a: { roll: 0, x: 5, y: 5, rot: 0 },
      b: { roll: 0, x: 9, y: 9, rot: 0 }, // overlaps a
      c: { roll: 0, x: 1795, y: 5, rot: 0 }, // hangs off the end
    };
    const issues = findLayoutIssues(pieces, placements, cfg);
    expect(issues.overlapping).toEqual(new Set(['a', 'b']));
    expect(issues.outOfBounds).toEqual(new Set(['c']));
  });
});

describe('polygon helpers', () => {
  it('computes area and perimeter of simple shapes', () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(polygonArea(square)).toBeCloseTo(100);
    expect(polygonPerimeter(square)).toBeCloseTo(40);
    const triangle = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    expect(polygonArea(triangle)).toBeCloseTo(50);
    expect(polygonPerimeter(triangle)).toBeCloseTo(20 + Math.hypot(10, 10));
  });

  it('winding direction does not change the area', () => {
    const cw = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }];
    expect(polygonArea(cw)).toBeCloseTo(100);
  });

  it('offsetArea matches the box bleed formula for rectangles', () => {
    // Box billing: (w + 2b)(h + 2b) = wh + 2b(w+h) + 4b² = A + P·b + 4b².
    // The polygon offset uses πb² for the corners (round join) — slightly
    // smaller than the box's 4b², otherwise identical.
    const A = 200, P = 60, b = 0.25;
    expect(offsetArea(A, P, b)).toBeCloseTo(A + P * b + Math.PI * b * b);
    expect(offsetArea(A, P, 0)).toBe(A);
  });
});

describe('fmtFtIn', () => {
  it('formats inches as feet and inches', () => {
    expect(fmtFtIn(11)).toBe('11"');
    expect(fmtFtIn(24)).toBe("2'");
    expect(fmtFtIn(148)).toBe(`12' 4"`);
    expect(fmtFtIn(1800)).toBe("150'");
  });
});

describe('DEFAULT_ROLL', () => {
  it('is the 58.5" × 150 ft roll', () => {
    expect(DEFAULT_ROLL.widthIn).toBe(58.5);
    expect(DEFAULT_ROLL.lengthIn).toBe(1800);
  });
});
