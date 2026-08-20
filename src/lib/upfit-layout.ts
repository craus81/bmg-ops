/**
 * Upfit designer layout math (roadmap N4, 3D phase — Craig 2026-08-20).
 *
 * Everything spatial the 3D upfit designer does lives here as pure functions
 * over plain data: collision, containment, snapping, placement ops, undo, and
 * the parts-list aggregation. The three.js components stay thin views over
 * this state — vitest runs in a node environment (no WebGL, no jsdom), so the
 * split is what makes the designer testable at all (same factoring as
 * roll-nesting.ts ↔ RollNesting.tsx). Nothing in this file may import three.
 *
 * World units are INCHES (three.js is unitless — the scene adopts them 1:1).
 * Origin: cargo-floor center at the bulkhead face. +Z runs rearward toward
 * the rear doors, +Y up, +X toward the passenger (right) side. An item's
 * `pos` is [footprint-center X, bottom Y, footprint-center Z]; `rot` is yaw
 * in quarter turns only, which keeps every box axis-aligned — collision and
 * snapping stay simple AABB math with a width/depth swap, and that is the
 * deliberate v1 trade against free rotation.
 */

// ── Geometry types (mirror vehicle_interiors.geometry / upfit_designs.layout) ──

export interface WheelWell {
  side: 'left' | 'right';
  from_bulkhead: number;
  length: number;
  width: number;
  height: number;
}

export interface DoorAperture {
  width: number;
  height: number;
}

export interface SideDoorAperture extends DoorAperture {
  side: 'left' | 'right';
  from_bulkhead: number;
}

export interface InteriorGeometry {
  version: number;
  units: 'in';
  cargo: {
    length: number;
    width: number;
    height: number;
    width_between_wheelwells: number;
  };
  wheelwells: WheelWell[];
  doors?: {
    rear?: DoorAperture;
    side?: SideDoorAperture;
  };
}

export type Rotation = 0 | 90 | 180 | 270;

/** Where an item lives, which also decides its drag plane: floor items move
 *  in X/Z with their bottom on the floor; wall items are pinned flush to
 *  their wall and move in Z/Y. */
export type Zone = 'floor' | 'wall_left' | 'wall_right' | 'ceiling';

/** One physical unit in the scene. Catalog facts (label, dims, price, labor)
 *  are SNAPSHOTTED at placement — like wrap_quotes.measurements, a saved
 *  design must survive later catalog edits unchanged. */
export interface PlacedItem {
  uid: string;
  part_id: string | null;
  item_number: string;
  label: string;
  category: string | null;
  w: number; // unrotated footprint left-right (in)
  d: number; // unrotated footprint front-back (in)
  h: number; // height (in)
  pos: [number, number, number]; // [center X, bottom Y, center Z]
  rot: Rotation;
  zone: Zone;
  unit_price: number | null;
  labor_hours: number | null;
}

/** A part on the design without dims — it can't enter the scene, but it
 *  still rides the parts list, the PDF, and the estimate. */
export interface UnplacedItem {
  part_id: string | null;
  item_number: string;
  label: string;
  category: string | null;
  qty: number;
  unit_price: number | null;
  labor_hours: number | null;
}

export interface LayoutState {
  version: 1;
  units: 'in';
  items: PlacedItem[];
  unplaced: UnplacedItem[];
}

export const emptyLayout = (): LayoutState => ({ version: 1, units: 'in', items: [], unplaced: [] });

/** Parse a stored layout defensively — a hand-edited or future-versioned
 *  JSONB row must never crash the designer. Unknown shapes come back empty. */
export function parseLayout(raw: unknown): LayoutState {
  if (!raw || typeof raw !== 'object') return emptyLayout();
  const o = raw as any;
  const items = Array.isArray(o.items)
    ? o.items.filter((i: any) => i && typeof i.uid === 'string' && Array.isArray(i.pos) && i.pos.length === 3
        && [i.w, i.d, i.h, ...i.pos].every((n: any) => Number.isFinite(n)))
    : [];
  const unplaced = Array.isArray(o.unplaced)
    ? o.unplaced.filter((u: any) => u && typeof u.item_number === 'string' && Number.isFinite(u.qty) && u.qty > 0)
    : [];
  return { version: 1, units: 'in', items, unplaced };
}

// ── AABB math ──

export interface Aabb {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

/** Faces that merely touch are NOT collisions — snapped-flush neighbors are
 *  the normal state of a good layout. */
const EPS = 0.01;

/** Rotated footprint: quarter turns swap width and depth. */
export const footprint = (item: Pick<PlacedItem, 'w' | 'd' | 'rot'>): { fw: number; fd: number } =>
  item.rot === 90 || item.rot === 270 ? { fw: item.d, fd: item.w } : { fw: item.w, fd: item.d };

export function itemAabb(item: PlacedItem): Aabb {
  const { fw, fd } = footprint(item);
  const [cx, by, cz] = item.pos;
  return {
    minX: cx - fw / 2, maxX: cx + fw / 2,
    minY: by, maxY: by + item.h,
    minZ: cz - fd / 2, maxZ: cz + fd / 2,
  };
}

export const aabbsOverlap = (a: Aabb, b: Aabb): boolean =>
  a.minX < b.maxX - EPS && a.maxX > b.minX + EPS &&
  a.minY < b.maxY - EPS && a.maxY > b.minY + EPS &&
  a.minZ < b.maxZ - EPS && a.maxZ > b.minZ + EPS;

export const collides = (a: PlacedItem, b: PlacedItem): boolean =>
  aabbsOverlap(itemAabb(a), itemAabb(b));

/** Every overlapping pair, as uid tuples — the HUD count and the red
 *  highlight both come from this. */
export function overlapPairs(items: PlacedItem[]): [string, string][] {
  const out: [string, string][] = [];
  const boxes = items.map(itemAabb);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (aabbsOverlap(boxes[i], boxes[j])) out.push([items[i].uid, items[j].uid]);
    }
  }
  return out;
}

/** Wheel wells as solid boxes in world coords. `side: 'left'` is the driver
 *  side (−X); wells grow inward from their wall. */
export function wheelwellBoxes(interior: InteriorGeometry): Aabb[] {
  const halfW = interior.cargo.width / 2;
  return interior.wheelwells.map(w => ({
    minX: w.side === 'left' ? -halfW : halfW - w.width,
    maxX: w.side === 'left' ? -halfW + w.width : halfW,
    minY: 0,
    maxY: w.height,
    minZ: w.from_bulkhead,
    maxZ: w.from_bulkhead + w.length,
  }));
}

/** Fully inside the cargo box (floor, walls, ceiling, bulkhead, rear). */
export function containsWithinShell(item: PlacedItem, interior: InteriorGeometry): boolean {
  const a = itemAabb(item);
  const halfW = interior.cargo.width / 2;
  return a.minX >= -halfW - EPS && a.maxX <= halfW + EPS &&
    a.minY >= -EPS && a.maxY <= interior.cargo.height + EPS &&
    a.minZ >= -EPS && a.maxZ <= interior.cargo.length + EPS;
}

/** Overlapping a wheel-well solid — a warning, not a block: some products
 *  (well-notched shelving) legitimately straddle a well, so the designer
 *  flags instead of forbidding. */
export function overlapsWheelwell(item: PlacedItem, interior: InteriorGeometry): boolean {
  const a = itemAabb(item);
  return wheelwellBoxes(interior).some(w => aabbsOverlap(a, w));
}

/** Pull an item back inside the shell (position only — an item taller or
 *  wider than the cargo box stays oversized and shows as an out-of-shell
 *  warning instead of being silently resized). */
export function clampToShell(item: PlacedItem, interior: InteriorGeometry): PlacedItem {
  const { fw, fd } = footprint(item);
  const halfW = interior.cargo.width / 2;
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? v : Math.min(Math.max(v, lo), hi));
  const [cx, by, cz] = item.pos;
  return {
    ...item,
    pos: [
      clamp(cx, -halfW + fw / 2, halfW - fw / 2),
      clamp(by, 0, Math.max(0, interior.cargo.height - item.h)),
      clamp(cz, fd / 2, interior.cargo.length - fd / 2),
    ],
  };
}

// ── Snapping ──

export interface SnapResult {
  pos: [number, number, number];
  /** World-coordinate guide planes that grabbed the item, for the scene to
   *  draw: e.g. { axis: 'x', at: -35.1 } is a vertical plane at X=-35.1. */
  guides: { axis: 'x' | 'z'; at: number }[];
}

/** Wall/bulkhead/rear snap: when a face is within `threshold` of a shell
 *  plane, land flush against it. */
export function snapToWalls(item: PlacedItem, interior: InteriorGeometry, threshold = 1.5): SnapResult {
  const { fw, fd } = footprint(item);
  const halfW = interior.cargo.width / 2;
  let [cx, by, cz] = item.pos;
  const guides: SnapResult['guides'] = [];
  if (Math.abs((cx - fw / 2) - -halfW) <= threshold) { cx = -halfW + fw / 2; guides.push({ axis: 'x', at: -halfW }); }
  else if (Math.abs((cx + fw / 2) - halfW) <= threshold) { cx = halfW - fw / 2; guides.push({ axis: 'x', at: halfW }); }
  if (Math.abs(cz - fd / 2) <= threshold) { cz = fd / 2; guides.push({ axis: 'z', at: 0 }); }
  else if (Math.abs((cz + fd / 2) - interior.cargo.length) <= threshold) {
    cz = interior.cargo.length - fd / 2;
    guides.push({ axis: 'z', at: interior.cargo.length });
  }
  return { pos: [cx, by, cz], guides };
}

/**
 * Neighbor snap: align to another item's edges when within `threshold`.
 * Only neighbors whose extent overlaps on the OTHER axis count — a cabinet
 * at the far end of the van must not yank an item sideways. Candidate
 * alignments per axis are edge-to-edge (flush adjacency) and edge-to-same-
 * edge (row alignment); the smallest correction wins.
 */
export function snapToNeighbors(item: PlacedItem, others: PlacedItem[], threshold = 1): SnapResult {
  const me = itemAabb(item);
  let [cx, by, cz] = item.pos;
  const guides: SnapResult['guides'] = [];
  let bestX: { delta: number; at: number } | null = null;
  let bestZ: { delta: number; at: number } | null = null;
  for (const other of others) {
    if (other.uid === item.uid) continue;
    const o = itemAabb(other);
    const overlapsZ = me.minZ < o.maxZ && me.maxZ > o.minZ;
    const overlapsX = me.minX < o.maxX && me.maxX > o.minX;
    if (overlapsZ) {
      for (const [myEdge, at] of [[me.minX, o.maxX], [me.maxX, o.minX], [me.minX, o.minX], [me.maxX, o.maxX]] as const) {
        const delta = at - myEdge;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, at };
      }
    }
    if (overlapsX) {
      for (const [myEdge, at] of [[me.minZ, o.maxZ], [me.maxZ, o.minZ], [me.minZ, o.minZ], [me.maxZ, o.maxZ]] as const) {
        const delta = at - myEdge;
        if (Math.abs(delta) <= threshold && (!bestZ || Math.abs(delta) < Math.abs(bestZ.delta))) bestZ = { delta, at };
      }
    }
  }
  if (bestX) { cx += bestX.delta; guides.push({ axis: 'x', at: bestX.at }); }
  if (bestZ) { cz += bestZ.delta; guides.push({ axis: 'z', at: bestZ.at }); }
  return { pos: [cx, by, cz], guides };
}

/** The drag pipeline: neighbor snap, then wall snap (walls win ties — flush
 *  to the van beats flush to a box), then clamp back inside the shell. */
export function snapPosition(
  item: PlacedItem,
  interior: InteriorGeometry,
  others: PlacedItem[],
): { item: PlacedItem; guides: SnapResult['guides'] } {
  const n = snapToNeighbors(item, others);
  const w = snapToWalls({ ...item, pos: n.pos }, interior);
  const guides = [...w.guides];
  for (const g of n.guides) {
    if (!guides.some(x => x.axis === g.axis)) guides.push(g);
  }
  const snapped = clampToShell({ ...item, pos: w.pos }, interior);
  return { item: snapped, guides };
}

// ── Zones, categories, trades ──

/** Default placement zone. mount_type (admin-authored, migration 213) wins;
 *  category is the fallback so an untyped part still lands sensibly. Floor
 *  is the safe default — a wrong wall guess pins the item somewhere the rep
 *  then can't drag it away from. */
export function defaultZoneFor(mountType: string | null | undefined, category?: string | null): Zone {
  if (mountType === 'wall') return 'wall_left';
  if (mountType === 'ceiling') return 'ceiling';
  if (mountType === 'floor' || mountType === 'partition' || mountType === 'door' || mountType === 'accessory') return 'floor';
  return 'floor';
}

/** Scene color per product category (the ten seeded product_categories rows
 *  plus a neutral fallback). Muted, distinguishable against the gray shell. */
const CATEGORY_COLORS: Record<string, string> = {
  'Shelving': '#4a7fb5',
  'Partitions': '#8a8f98',
  'Ladder Racks': '#b5884a',
  'Bins & Drawers': '#4ab578',
  'Flooring': '#7a6a55',
  'Lighting & Electrical': '#c9b458',
  'Safety & Security': '#c95858',
  'Telematics': '#9c58c9',
  'Graphics & Wraps': '#58b5c9',
  'Labor & Services': '#6b7280',
};
export const categoryColor = (category: string | null | undefined): string =>
  (category && CATEGORY_COLORS[category]) || '#6b7fb5';

/** Trade-package vocabulary for upfit_designs.trade. The column is freeform
 *  text; this list just gates the picker UI, so adding a trade is one entry. */
export const TRADES = [
  { key: 'electrical', label: 'Electrical' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'general_contractor', label: 'General Contractor' },
  { key: 'plumbing', label: 'Plumbing' },
  { key: 'hvac', label: 'HVAC' },
  { key: 'locksmith', label: 'Locksmith' },
] as const;
export type TradeKey = (typeof TRADES)[number]['key'];

// ── Auto layout ──

export interface AutoLayoutEntry {
  part_id: string | null;
  item_number: string;
  label: string;
  category: string | null;
  w: number; d: number; h: number;
  qty: number;
  unit_price: number | null;
  labor_hours: number | null;
  mount_type?: string | null;
}

const AUTO_GAP = 1; // breathing inch between auto-placed units

/**
 * Deterministic first-pass placement for kit imports and "add from catalog":
 * walk the left wall bulkhead→rear, then the right wall, standing each unit
 * flush against the wall (width along the wall, depth sticking inward) and
 * skipping stretches blocked by wheel wells or already-placed items. Units
 * that fit nowhere are returned as overflow for the unplaced list. uids come
 * from the caller so this stays pure and reproducible in tests.
 */
export function autoLayout(
  entries: AutoLayoutEntry[],
  interior: InteriorGeometry,
  existing: PlacedItem[],
  nextUid: () => string,
): { placed: PlacedItem[]; overflow: AutoLayoutEntry[] } {
  const placed: PlacedItem[] = [];
  const overflow: AutoLayoutEntry[] = [];
  const halfW = interior.cargo.width / 2;
  const wells = wheelwellBoxes(interior);

  const tryPlace = (entry: AutoLayoutEntry): PlacedItem | null => {
    for (const wall of ['wall_left', 'wall_right'] as const) {
      // Flush to the wall: depth points inward, width runs along Z (rot 90).
      // The ZONE stays what the part's mount type says — a floor-standing
      // shelf positioned against a wall still drags on the floor plane;
      // only genuinely wall-hung parts get a wall zone (and its drag plane).
      const zone: Zone = entry.mount_type === 'wall' ? wall : 'floor';
      const cx = wall === 'wall_left' ? -halfW + entry.d / 2 : halfW - entry.d / 2;
      let cz = entry.w / 2;
      while (cz + entry.w / 2 <= interior.cargo.length + EPS) {
        const candidate: PlacedItem = {
          uid: '', part_id: entry.part_id, item_number: entry.item_number, label: entry.label,
          category: entry.category, w: entry.w, d: entry.d, h: entry.h,
          pos: [cx, 0, cz], rot: 90, zone,
          unit_price: entry.unit_price, labor_hours: entry.labor_hours,
        };
        const box = itemAabb(candidate);
        const blockers = [
          ...wells,
          ...existing.map(itemAabb),
          ...placed.map(itemAabb),
        ].filter(b => aabbsOverlap(box, b));
        if (blockers.length === 0 && containsWithinShell(candidate, interior)) {
          return { ...candidate, uid: nextUid() };
        }
        // Jump past the nearest blocker's rear edge and try again.
        const nextZ = Math.min(...blockers.map(b => b.maxZ));
        cz = (Number.isFinite(nextZ) ? nextZ : interior.cargo.length) + AUTO_GAP + entry.w / 2;
      }
    }
    return null;
  };

  for (const entry of entries) {
    for (let i = 0; i < entry.qty; i++) {
      const hit = Number.isFinite(entry.w) && Number.isFinite(entry.d) && Number.isFinite(entry.h)
        && entry.w > 0 && entry.d > 0 && entry.h > 0 ? tryPlace(entry) : null;
      if (hit) {
        placed.push(hit);
      } else {
        const existing = overflow.find(o => o.item_number === entry.item_number);
        if (existing) existing.qty += 1;
        else overflow.push({ ...entry, qty: 1 });
      }
    }
  }
  return { placed, overflow };
}

// ── Layout ops + undo ──

export type LayoutOp =
  | { type: 'place'; item: PlacedItem }
  | { type: 'move'; uid: string; pos: [number, number, number] }
  | { type: 'rotate'; uid: string }
  | { type: 'remove'; uid: string }
  | { type: 'duplicate'; uid: string; newUid: string }
  | { type: 'nudge'; uid: string; dx?: number; dy?: number; dz?: number }
  | { type: 'add_unplaced'; entry: UnplacedItem }
  | { type: 'set_unplaced_qty'; item_number: string; qty: number }
  | { type: 'remove_unplaced'; item_number: string }
  | { type: 'set_layout'; layout: LayoutState };

export function applyOp(state: LayoutState, op: LayoutOp, interior: InteriorGeometry | null): LayoutState {
  const mapItem = (uid: string, fn: (i: PlacedItem) => PlacedItem): LayoutState => ({
    ...state,
    items: state.items.map(i => (i.uid === uid ? fn(i) : i)),
  });
  const maybeClamp = (i: PlacedItem): PlacedItem => (interior ? clampToShell(i, interior) : i);
  switch (op.type) {
    case 'place':
      return { ...state, items: [...state.items, maybeClamp(op.item)] };
    case 'move':
      return mapItem(op.uid, i => maybeClamp({ ...i, pos: op.pos }));
    case 'rotate':
      return mapItem(op.uid, i => maybeClamp({ ...i, rot: (((i.rot + 90) % 360) as Rotation) }));
    case 'remove':
      return { ...state, items: state.items.filter(i => i.uid !== op.uid) };
    case 'duplicate': {
      const src = state.items.find(i => i.uid === op.uid);
      if (!src) return state;
      const { fd } = footprint(src);
      const copy = maybeClamp({ ...src, uid: op.newUid, pos: [src.pos[0], src.pos[1], src.pos[2] + fd + AUTO_GAP] });
      return { ...state, items: [...state.items, copy] };
    }
    case 'nudge':
      return mapItem(op.uid, i => maybeClamp({
        ...i,
        pos: [i.pos[0] + (op.dx || 0), i.pos[1] + (op.dy || 0), i.pos[2] + (op.dz || 0)],
      }));
    case 'add_unplaced': {
      const existing = state.unplaced.find(u => u.item_number === op.entry.item_number);
      if (existing) {
        return {
          ...state,
          unplaced: state.unplaced.map(u => (u.item_number === op.entry.item_number ? { ...u, qty: u.qty + op.entry.qty } : u)),
        };
      }
      return { ...state, unplaced: [...state.unplaced, op.entry] };
    }
    case 'set_unplaced_qty':
      return op.qty <= 0
        ? { ...state, unplaced: state.unplaced.filter(u => u.item_number !== op.item_number) }
        : { ...state, unplaced: state.unplaced.map(u => (u.item_number === op.item_number ? { ...u, qty: op.qty } : u)) };
    case 'remove_unplaced':
      return { ...state, unplaced: state.unplaced.filter(u => u.item_number !== op.item_number) };
    case 'set_layout':
      return op.layout;
    default:
      return state;
  }
}

export interface UndoableLayout {
  past: LayoutState[];
  present: LayoutState;
  future: LayoutState[];
}

export const initialUndoable = (layout: LayoutState): UndoableLayout => ({ past: [], present: layout, future: [] });

const HISTORY_CAP = 100;

/**
 * Apply an op with history. `transient` ops (every mouse-move of a drag)
 * replace the present without pushing history; the gesture calls
 * `checkpoint` once at its start, so Ctrl+Z steps back a whole drag to the
 * PRE-drag state — not one pixel, and not the drop position.
 */
export function undoableApply(s: UndoableLayout, op: LayoutOp, interior: InteriorGeometry | null, opts?: { transient?: boolean }): UndoableLayout {
  const next = applyOp(s.present, op, interior);
  if (next === s.present) return s;
  if (opts?.transient) return { ...s, present: next };
  return {
    past: [...s.past.slice(-(HISTORY_CAP - 1)), s.present],
    present: next,
    future: [],
  };
}

/** Push the current state onto history without changing it — call once when
 *  a drag gesture actually starts moving, before its transient ops. */
export const checkpoint = (s: UndoableLayout): UndoableLayout => ({
  past: [...s.past.slice(-(HISTORY_CAP - 1)), s.present],
  present: s.present,
  future: [],
});

export const undo = (s: UndoableLayout): UndoableLayout =>
  s.past.length === 0 ? s : {
    past: s.past.slice(0, -1),
    present: s.past[s.past.length - 1],
    future: [s.present, ...s.future],
  };

export const redo = (s: UndoableLayout): UndoableLayout =>
  s.future.length === 0 ? s : {
    past: [...s.past, s.present],
    present: s.future[0],
    future: s.future.slice(1),
  };

// ── Warnings + parts list ──

export interface LayoutWarnings {
  overlaps: [string, string][];
  outOfShell: string[];
  overWheelwell: string[];
}

export function layoutWarnings(items: PlacedItem[], interior: InteriorGeometry): LayoutWarnings {
  return {
    overlaps: overlapPairs(items),
    outOfShell: items.filter(i => !containsWithinShell(i, interior)).map(i => i.uid),
    overWheelwell: items.filter(i => overlapsWheelwell(i, interior)).map(i => i.uid),
  };
}

export interface AggregatedLine {
  part_id: string | null;
  item_number: string;
  description: string;
  quantity: number;
  unit_price: number;
  labor_hours: number;
  placed: boolean;
}

/**
 * The design's parts list: placed units grouped by item number (each scene
 * box is one physical unit) plus the unplaced entries. This is the exact
 * shape the review panel totals, the PDF tabulates, and the estimate POST
 * sends as line_items.
 */
export function aggregateLines(layout: LayoutState): AggregatedLine[] {
  const byNumber = new Map<string, AggregatedLine>();
  for (const i of layout.items) {
    const line = byNumber.get(i.item_number);
    if (line) line.quantity += 1;
    else byNumber.set(i.item_number, {
      part_id: i.part_id, item_number: i.item_number, description: i.label,
      quantity: 1, unit_price: i.unit_price ?? 0, labor_hours: i.labor_hours ?? 0, placed: true,
    });
  }
  const out = [...byNumber.values()];
  for (const u of layout.unplaced) {
    out.push({
      part_id: u.part_id, item_number: u.item_number, description: u.label,
      quantity: u.qty, unit_price: u.unit_price ?? 0, labor_hours: u.labor_hours ?? 0, placed: false,
    });
  }
  return out;
}
