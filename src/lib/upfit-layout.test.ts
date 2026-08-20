import { describe, it, expect } from 'vitest';
import {
  InteriorGeometry,
  PlacedItem,
  aggregateLines,
  applyOp,
  autoLayout,
  checkpoint,
  clampToShell,
  collides,
  containsWithinShell,
  defaultZoneFor,
  emptyLayout,
  footprint,
  initialUndoable,
  itemAabb,
  layoutWarnings,
  overlapPairs,
  overlapsWheelwell,
  parseLayout,
  redo,
  snapPosition,
  snapToNeighbors,
  snapToWalls,
  undo,
  undoableApply,
  wheelwellBoxes,
} from './upfit-layout';

// A simplified Transit-148-high-ish interior: 140 long, 70 wide, 80 tall,
// symmetric wells 8 wide × 36 long × 10 tall starting 80" from the bulkhead.
const interior: InteriorGeometry = {
  version: 1,
  units: 'in',
  cargo: { length: 140, width: 70, height: 80, width_between_wheelwells: 54 },
  wheelwells: [
    { side: 'left', from_bulkhead: 80, length: 36, width: 8, height: 10 },
    { side: 'right', from_bulkhead: 80, length: 36, width: 8, height: 10 },
  ],
  doors: { rear: { width: 60, height: 74 }, side: { side: 'right', from_bulkhead: 0, width: 50, height: 72 } },
};

let uidCounter = 0;
const item = (over: Partial<PlacedItem> = {}): PlacedItem => ({
  uid: `u${uidCounter++}`,
  part_id: null,
  item_number: 'F5-RA48',
  label: '48" Shelving Unit',
  category: 'Shelving',
  w: 48, d: 14, h: 46,
  pos: [0, 0, 40],
  rot: 0,
  zone: 'floor',
  unit_price: 500,
  labor_hours: 1.5,
  ...over,
});

describe('footprint / itemAabb', () => {
  it('swaps width and depth on quarter turns', () => {
    expect(footprint({ w: 48, d: 14, rot: 0 })).toEqual({ fw: 48, fd: 14 });
    expect(footprint({ w: 48, d: 14, rot: 90 })).toEqual({ fw: 14, fd: 48 });
    expect(footprint({ w: 48, d: 14, rot: 180 })).toEqual({ fw: 48, fd: 14 });
    expect(footprint({ w: 48, d: 14, rot: 270 })).toEqual({ fw: 14, fd: 48 });
  });

  it('builds the box around the footprint center with pos[1] as the bottom', () => {
    const a = itemAabb(item({ pos: [10, 5, 50] }));
    expect(a).toEqual({ minX: -14, maxX: 34, minY: 5, maxY: 51, minZ: 43, maxZ: 57 });
  });
});

describe('collision', () => {
  it('detects overlap and ignores mere face contact', () => {
    const a = item({ pos: [0, 0, 40] });
    const flush = item({ pos: [48, 0, 40] }); // faces touch exactly at x=24
    const overlapping = item({ pos: [40, 0, 40] });
    expect(collides(a, flush)).toBe(false);
    expect(collides(a, overlapping)).toBe(true);
  });

  it('stacked items at different heights do not collide', () => {
    const low = item({ h: 20, pos: [0, 0, 40] });
    const high = item({ h: 20, pos: [0, 20, 40] });
    expect(collides(low, high)).toBe(false);
  });

  it('overlapPairs finds every colliding pair by uid', () => {
    const a = item({ uid: 'a', pos: [0, 0, 40] });
    const b = item({ uid: 'b', pos: [10, 0, 40] });
    const c = item({ uid: 'c', pos: [0, 0, 120] });
    expect(overlapPairs([a, b, c])).toEqual([['a', 'b']]);
  });
});

describe('shell containment + wheel wells', () => {
  it('accepts an item inside and rejects one poking through a wall', () => {
    expect(containsWithinShell(item({ pos: [0, 0, 40] }), interior)).toBe(true);
    expect(containsWithinShell(item({ pos: [30, 0, 40] }), interior)).toBe(false); // maxX 54 > 35
    expect(containsWithinShell(item({ pos: [0, 40, 40] }), interior)).toBe(false); // maxY 86 > 80
  });

  it('places wheel wells against their walls', () => {
    const [left, right] = wheelwellBoxes(interior);
    expect(left).toMatchObject({ minX: -35, maxX: -27, minZ: 80, maxZ: 116, maxY: 10 });
    expect(right).toMatchObject({ minX: 27, maxX: 35, minZ: 80, maxZ: 116 });
  });

  it('flags an item sitting on a wheel well', () => {
    const overWell = item({ rot: 90, pos: [-28, 0, 95] }); // 14 wide against left wall, z inside well span
    expect(overlapsWheelwell(overWell, interior)).toBe(true);
    const clearOfWell = item({ rot: 90, pos: [-28, 0, 30] });
    expect(overlapsWheelwell(clearOfWell, interior)).toBe(false);
    // Above the well height is clear even over its footprint.
    const shelfAboveWell = item({ rot: 90, pos: [-28, 12, 95] });
    expect(overlapsWheelwell(shelfAboveWell, interior)).toBe(false);
  });

  it('clampToShell pulls the position back inside without resizing', () => {
    const wild = item({ pos: [100, -5, 300] });
    const clamped = clampToShell(wild, interior);
    expect(clamped.pos).toEqual([35 - 24, 0, 140 - 7]);
    expect(clamped.w).toBe(48);
    // An item taller than the cargo box keeps y=0 (it stays oversized and
    // warns, rather than being shoved through the floor).
    const tall = clampToShell(item({ h: 90, pos: [0, 8, 40] }), interior);
    expect(tall.pos[1]).toBe(0);
  });
});

describe('snapping', () => {
  it('snaps a near-wall face flush to the wall', () => {
    // rot 90 → footprint 14 wide; left wall at -35, so flush center is -28.
    const near = item({ rot: 90, pos: [-27.2, 0, 40] });
    const { pos, guides } = snapToWalls(near, interior);
    expect(pos[0]).toBeCloseTo(-28);
    expect(guides).toContainEqual({ axis: 'x', at: -35 });
  });

  it('snaps to the bulkhead and rear planes on z', () => {
    const nearBulkhead = item({ pos: [0, 0, 7.8] }); // minZ = 0.8
    expect(snapToWalls(nearBulkhead, interior).pos[2]).toBeCloseTo(7);
    const nearRear = item({ pos: [0, 0, 133.8] }); // maxZ = 140.8 → clamps to 133
    expect(snapToWalls(nearRear, interior).pos[2]).toBeCloseTo(133);
  });

  it('leaves a mid-floor item alone', () => {
    const mid = item({ pos: [0, 0, 60] });
    const r = snapToWalls(mid, interior);
    expect(r.pos).toEqual([0, 0, 60]);
    expect(r.guides).toHaveLength(0);
  });

  it('snaps edge-to-edge against a neighbor sharing the other axis', () => {
    const anchor = item({ uid: 'anchor', pos: [0, 0, 40] }); // maxZ = 47
    const dragged = item({ uid: 'drag', pos: [0, 0, 54.6] }); // minZ = 47.6 → 0.6 away
    const r = snapToNeighbors(dragged, [anchor]);
    expect(r.pos[2]).toBeCloseTo(54);
    expect(r.guides).toContainEqual({ axis: 'z', at: 47 });
  });

  it('ignores a neighbor with no overlap on the perpendicular axis', () => {
    const anchor = item({ uid: 'anchor', rot: 90, pos: [-28, 0, 40] }); // x: -35..-21
    const dragged = item({ uid: 'drag', rot: 90, pos: [28, 0, 64.5] }); // x: 21..35 — opposite wall
    const r = snapToNeighbors(dragged, [anchor]);
    expect(r.pos).toEqual([28, 0, 64.5]);
  });

  it('snapPosition composes neighbor + wall snap and clamps', () => {
    const anchor = item({ uid: 'anchor', rot: 90, pos: [-28, 0, 24] }); // along left wall, maxZ = 48
    const dragged = item({ uid: 'drag', rot: 90, pos: [-27, 0, 72.7] }); // near wall, near anchor edge
    const { item: snapped, guides } = snapPosition(dragged, interior, [anchor]);
    expect(snapped.pos[0]).toBeCloseTo(-28); // wall flush
    expect(snapped.pos[2]).toBeCloseTo(72); // minZ 48.7 → snapped to anchor maxZ 48
    expect(guides.length).toBeGreaterThanOrEqual(1);
  });
});

describe('zones', () => {
  it('mount_type wins; unknown defaults to floor', () => {
    expect(defaultZoneFor('wall', 'Shelving')).toBe('wall_left');
    expect(defaultZoneFor('ceiling', null)).toBe('ceiling');
    expect(defaultZoneFor('floor', 'Bins & Drawers')).toBe('floor');
    expect(defaultZoneFor(null, 'Shelving')).toBe('floor');
    expect(defaultZoneFor(undefined, undefined)).toBe('floor');
  });
});

describe('autoLayout', () => {
  const entry = (over: Partial<Parameters<typeof autoLayout>[0][number]> = {}) => ({
    part_id: null, item_number: 'F5-RA48', label: '48" Shelf', category: 'Shelving',
    w: 48, d: 14, h: 46, qty: 1, unit_price: 500, labor_hours: 1.5, ...over,
  });
  const uidGen = () => { let n = 0; return () => `a${n++}`; };

  it('fills the left wall, then falls over to the right wall past the well', () => {
    const { placed, overflow } = autoLayout([entry({ qty: 2 })], interior, [], uidGen());
    expect(overflow).toHaveLength(0);
    expect(placed).toHaveLength(2);
    // First flush to the left wall from the bulkhead (depth 14 → center -28).
    expect(placed[0].pos[0]).toBeCloseTo(-28);
    expect(placed[0].pos[2]).toBeCloseTo(24);
    // The left wall's remaining stretch before the well (z 49-79) is too
    // short for a 48" unit, so the second lands on the right wall instead.
    expect(placed[1].pos[0]).toBeCloseTo(28);
    expect(placed[1].pos[2]).toBeCloseTo(24);
    expect(overlapPairs(placed)).toHaveLength(0);
    for (const p of placed) expect(overlapsWheelwell(p, interior)).toBe(false);
  });

  it('is deterministic for the same inputs', () => {
    const a = autoLayout([entry({ qty: 3 })], interior, [], uidGen());
    const b = autoLayout([entry({ qty: 3 })], interior, [], uidGen());
    expect(a.placed.map(p => p.pos)).toEqual(b.placed.map(p => p.pos));
  });

  it('overflows what cannot fit and units without dims', () => {
    const huge = entry({ item_number: 'HUGE', w: 300, d: 14, h: 46 });
    const dimless = entry({ item_number: 'NODIMS', w: 0, d: 0, h: 0, qty: 2 });
    const { placed, overflow } = autoLayout([huge, dimless], interior, [], uidGen());
    expect(placed).toHaveLength(0);
    expect(overflow).toEqual([
      expect.objectContaining({ item_number: 'HUGE', qty: 1 }),
      expect.objectContaining({ item_number: 'NODIMS', qty: 2 }),
    ]);
  });

  it('respects existing items as blockers', () => {
    const blocker = item({ rot: 90, pos: [-28, 0, 24] }); // occupies left wall z 0..48
    const { placed } = autoLayout([entry()], interior, [blocker], uidGen());
    expect(placed).toHaveLength(1);
    expect(overlapPairs([blocker, placed[0]])).toHaveLength(0);
    expect(overlapsWheelwell(placed[0], interior)).toBe(false);
  });
});

describe('applyOp + undo/redo', () => {
  it('place / move / rotate / remove round trip', () => {
    let s = emptyLayout();
    const a = item({ uid: 'a' });
    s = applyOp(s, { type: 'place', item: a }, interior);
    expect(s.items).toHaveLength(1);
    s = applyOp(s, { type: 'move', uid: 'a', pos: [10, 0, 60] }, interior);
    expect(s.items[0].pos).toEqual([10, 0, 60]);
    s = applyOp(s, { type: 'rotate', uid: 'a' }, interior);
    expect(s.items[0].rot).toBe(90);
    s = applyOp(s, { type: 'remove', uid: 'a' }, interior);
    expect(s.items).toHaveLength(0);
  });

  it('rotate near a wall clamps back inside', () => {
    // 48-wide item flush against the left wall; rotating swaps to 14 wide —
    // and the clamp keeps the new footprint inside the shell.
    let s = applyOp(emptyLayout(), { type: 'place', item: item({ uid: 'a', pos: [-11, 0, 40] }) }, interior);
    s = applyOp(s, { type: 'rotate', uid: 'a' }, interior);
    expect(containsWithinShell(s.items[0], interior)).toBe(true);
  });

  it('duplicate lands behind the source and clamps', () => {
    let s = applyOp(emptyLayout(), { type: 'place', item: item({ uid: 'a', pos: [0, 0, 130] }) }, interior);
    s = applyOp(s, { type: 'duplicate', uid: 'a', newUid: 'b' }, interior);
    expect(s.items).toHaveLength(2);
    expect(containsWithinShell(s.items[1], interior)).toBe(true);
  });

  it('unplaced ops merge by item number and drop at qty 0', () => {
    const entry = { part_id: null, item_number: 'NODIMS', label: 'No dims', category: null, qty: 1, unit_price: 10, labor_hours: 0 };
    let s = applyOp(emptyLayout(), { type: 'add_unplaced', entry }, null);
    s = applyOp(s, { type: 'add_unplaced', entry }, null);
    expect(s.unplaced).toEqual([expect.objectContaining({ item_number: 'NODIMS', qty: 2 })]);
    s = applyOp(s, { type: 'set_unplaced_qty', item_number: 'NODIMS', qty: 0 }, null);
    expect(s.unplaced).toHaveLength(0);
  });

  it('undo/redo walks history; a drag (checkpoint + transients) is one step back to PRE-drag', () => {
    let u = initialUndoable(emptyLayout());
    u = undoableApply(u, { type: 'place', item: item({ uid: 'a' }) }, interior);
    // A drag: checkpoint once at gesture start, then only transient moves.
    u = checkpoint(u);
    u = undoableApply(u, { type: 'move', uid: 'a', pos: [1, 0, 41] }, interior, { transient: true });
    u = undoableApply(u, { type: 'move', uid: 'a', pos: [2, 0, 42] }, interior, { transient: true });
    u = undoableApply(u, { type: 'move', uid: 'a', pos: [3, 0, 43] }, interior, { transient: true });
    expect(u.past).toHaveLength(2); // empty → placed(pre-drag)
    u = undo(u);
    expect(u.present.items[0].pos).toEqual([0, 0, 40]); // back to PRE-drag, not mid-drag
    u = undo(u);
    expect(u.present.items).toHaveLength(0);
    u = redo(u);
    u = redo(u);
    expect(u.present.items[0].pos).toEqual([3, 0, 43]);
    // A fresh op clears the future.
    u = undo(u);
    u = undoableApply(u, { type: 'rotate', uid: 'a' }, interior);
    expect(u.future).toHaveLength(0);
  });
});

describe('warnings + aggregation + parsing', () => {
  it('layoutWarnings reports each category', () => {
    const ok = item({ uid: 'ok', pos: [0, 0, 40] });
    const clash = item({ uid: 'clash', pos: [4, 0, 40] });
    const outside = item({ uid: 'out', pos: [0, 50, 40] });
    const onWell = item({ uid: 'well', rot: 90, pos: [-28, 0, 95] });
    const w = layoutWarnings([ok, clash, outside, onWell], interior);
    expect(w.overlaps).toEqual([['ok', 'clash']]);
    expect(w.outOfShell).toEqual(['out']);
    expect(w.overWheelwell).toEqual(['well']);
  });

  it('aggregateLines groups placed units and appends unplaced entries', () => {
    const s = {
      ...emptyLayout(),
      items: [item({ uid: 'a' }), item({ uid: 'b' }), item({ uid: 'c', item_number: 'BIN-1', label: 'Bin', unit_price: 25, labor_hours: 0.2 })],
      unplaced: [{ part_id: null, item_number: 'NODIMS', label: 'No dims', category: null, qty: 3, unit_price: 10, labor_hours: 0.1 }],
    };
    expect(aggregateLines(s)).toEqual([
      expect.objectContaining({ item_number: 'F5-RA48', quantity: 2, unit_price: 500, labor_hours: 1.5, placed: true }),
      expect.objectContaining({ item_number: 'BIN-1', quantity: 1, unit_price: 25, placed: true }),
      expect.objectContaining({ item_number: 'NODIMS', quantity: 3, unit_price: 10, placed: false }),
    ]);
  });

  it('parseLayout survives garbage and strips malformed rows', () => {
    expect(parseLayout(null)).toEqual(emptyLayout());
    expect(parseLayout('nope')).toEqual(emptyLayout());
    expect(parseLayout({ items: 'x', unplaced: 7 })).toEqual(emptyLayout());
    const parsed = parseLayout({
      version: 1, units: 'in',
      items: [item({ uid: 'good' }), { uid: 'bad', pos: [1, 2] }, { uid: 'nan', pos: [1, 2, NaN], w: 1, d: 1, h: 1 }],
      unplaced: [{ item_number: 'OK', qty: 2 }, { item_number: 'ZERO', qty: 0 }, { qty: 3 }],
    });
    expect(parsed.items.map(i => i.uid)).toEqual(['good']);
    expect(parsed.unplaced.map(u => u.item_number)).toEqual(['OK']);
  });
});
