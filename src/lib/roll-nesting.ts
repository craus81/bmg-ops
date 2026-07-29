// Vinyl-roll nesting for the wrap-quote estimator.
//
// Pieces (drawn measurement shapes + bleed, one per copy per set) are laid
// out on fixed-width rolls of print film — 58.5" × 150' by default. The
// packer is a MaxRects variant tuned for rolls: the roll's width is fixed
// and the goal is to grow the used LENGTH as little as possible, because
// material is billed as roll width × consumed length. Films never share a
// roll (each film prints on its own material), so packing is per film.
//
// Coordinates: x runs ALONG the roll (length, the growing axis), y runs
// ACROSS it (width). All units are inches.

export interface RollConfig {
  widthIn: number; // across the roll (58.5 for a 60" roll with grip edges)
  lengthIn: number; // full roll length (150 ft = 1800)
  spacingIn: number; // minimum gap between pieces
  edgeMarginIn: number; // margin kept clear at the roll edges
  overlapIn: number; // seam overlap added when a panel is split to fit the width
}

// Edge margin defaults to 0: 58.5" is already the roll's PRINTABLE width,
// so vertical panels come out a true 58.5" wide (58.5 + 58.5 + 58.5 + 26
// covers a 200" side with 0.5" seam overlaps).
export const DEFAULT_ROLL: RollConfig = { widthIn: 58.5, lengthIn: 1800, spacingIn: 0.5, edgeMarginIn: 0, overlapIn: 0.5 };

// One physical piece to cut: a measurement copy within a set. w/h are the
// piece's print dimensions (drawn size + bleed on both sides); rotation at
// placement time decides which one runs along the roll. Panels too wide for
// the roll are split into lettered parts ("Panel 1-A", "Panel 1-B") before
// packing — `part` carries the letter, '' for unsplit pieces.
export interface NestPiece {
  key: string; // pieceKey(...) — stable per layout, changes when film changes
  filmKey: string; // film id, '' = no film assigned
  name: string;
  w: number;
  h: number;
  set: number; // 0-based set (kit) index
  copy: number; // 0-based copy index within the measurement's qty
  part: string; // 'A', 'B', … when split to fit the roll; '' otherwise
}

// Placement keys embed everything that invalidates a spot: the measurement,
// which copy/set/part it is, and the film (film changes move a piece to a
// different roll group, so its old placement must not survive).
export const pieceKey = (mid: string, copy: number, set: number, part: number, filmKey: string) =>
  `${mid}:${copy}:${set}:${part}:${filmKey}`;

export const partLetter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `P${i + 1}`);

/**
 * Split a panel that is wider than the roll in BOTH orientations into
 * VERTICAL panels, the way wraps are actually paneled: the drawn width is
 * sliced into full-roll-width panels plus one remainder panel, each the
 * panel's full height (which runs down the roll). Adjoining panels share a
 * seam overlap — extra printed material at every seam. A 200" × 96" box
 * side on a 58.5" roll with 0.5" overlap becomes 58.5, 58.5, 58.5, and 26
 * inches wide, all 96" tall. Returns [{w, h, partIndex}]; a single entry
 * with partIndex -1 means no split was needed.
 */
export function splitForRoll(w: number, h: number, config: RollConfig): { w: number; h: number; partIndex: number }[] {
  const usable = config.widthIn - 2 * config.edgeMarginIn;
  if (usable <= 0 || Math.min(w, h) <= usable) return [{ w, h, partIndex: -1 }];
  // min(w,h) > usable implies w > usable, so slicing the width always
  // produces panels that fit across the roll.
  const overlap = Math.max(0, Math.min(config.overlapIn, usable / 2));
  const step = usable - overlap; // net new coverage per added panel
  const n = Math.max(2, Math.ceil((w - overlap) / step));
  // Full-width panels first; the remainder panel covers what's left plus
  // its share of the seams: widths sum to w + (n−1)·overlap of print.
  const last = w - (n - 1) * step;
  return Array.from({ length: n }, (_, i) => ({ w: i < n - 1 ? usable : last, h, partIndex: i }));
}

export interface Placement {
  roll: number; // roll index within the piece's film group
  x: number; // inches from the start of the roll
  y: number; // inches from the roll edge
  rot: 0 | 90; // 90 = w/h swapped on the roll
}

export type PlacementMap = Record<string, Placement>;

export interface Rect { x: number; y: number; w: number; h: number }

const EPS = 1e-6;
// More rolls than any sane job; stops a pathological config from looping.
// Exported so snapshot restores can clamp corrupt roll indexes to the same
// bound the packer uses.
export const MAX_ROLLS_PER_FILM = 25;

export const placedSize = (p: NestPiece, rot: 0 | 90) =>
  rot === 90 ? { w: p.h, h: p.w } : { w: p.w, h: p.h };

export const placedRect = (p: NestPiece, pl: Placement): Rect => {
  const s = placedSize(p, pl.rot);
  return { x: pl.x, y: pl.y, w: s.w, h: s.h };
};

// ---------------------------------------------------------------- MaxRects

interface Bin { free: Rect[]; extent: number }

// Free space is tracked in "usable" coordinates (edge margins stripped) and
// inflated by the piece spacing on the far sides — the standard trick that
// turns "keep a gap between pieces" into plain rectangle fitting.
function newBin(usableLen: number, usableW: number, spacing: number): Bin {
  return { free: [{ x: 0, y: 0, w: usableLen + spacing, h: usableW + spacing }], extent: 0 };
}

function splitFreeRects(free: Rect[], used: Rect): Rect[] {
  const out: Rect[] = [];
  for (const fr of free) {
    if (
      used.x >= fr.x + fr.w - EPS || used.x + used.w <= fr.x + EPS ||
      used.y >= fr.y + fr.h - EPS || used.y + used.h <= fr.y + EPS
    ) { out.push(fr); continue; }
    if (used.x > fr.x + EPS) out.push({ x: fr.x, y: fr.y, w: used.x - fr.x, h: fr.h });
    if (used.x + used.w < fr.x + fr.w - EPS) out.push({ x: used.x + used.w, y: fr.y, w: fr.x + fr.w - used.x - used.w, h: fr.h });
    if (used.y > fr.y + EPS) out.push({ x: fr.x, y: fr.y, w: fr.w, h: used.y - fr.y });
    if (used.y + used.h < fr.y + fr.h - EPS) out.push({ x: fr.x, y: used.y + used.h, w: fr.w, h: fr.y + fr.h - used.y - used.h });
  }
  return pruneFreeRects(out);
}

function pruneFreeRects(free: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < free.length; i++) {
    const a = free[i];
    let redundant = false;
    for (let j = 0; j < free.length && !redundant; j++) {
      if (i === j) continue;
      const b = free[j];
      const contained =
        a.x >= b.x - EPS && a.y >= b.y - EPS &&
        a.x + a.w <= b.x + b.w + EPS && a.y + a.h <= b.y + b.h + EPS;
      if (!contained) continue;
      const identical =
        Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS &&
        Math.abs(a.w - b.w) < EPS && Math.abs(a.h - b.h) < EPS;
      // Duplicate rects keep only their first occurrence.
      redundant = !identical || j < i;
    }
    if (!redundant) out.push(a);
  }
  return out;
}

function occupy(bin: Bin, usableRect: Rect, spacing: number) {
  bin.free = splitFreeRects(bin.free, { ...usableRect, w: usableRect.w + spacing, h: usableRect.h + spacing });
  bin.extent = Math.max(bin.extent, usableRect.x + usableRect.w);
}

export interface PackResult { placements: PlacementMap; unplaced: NestPiece[] }

/**
 * Pack pieces onto rolls, film by film. `existing` placements are treated
 * as immovable obstacles (same film only), so re-packing after a manual
 * arrangement only fills the gaps instead of shuffling everything.
 */
export function packPieces(
  pieces: NestPiece[],
  config: RollConfig,
  existing: { piece: NestPiece; placement: Placement }[] = []
): PackResult {
  const margin = Math.max(0, config.edgeMarginIn);
  const spacing = Math.max(0, config.spacingIn);
  const usableW = config.widthIn - 2 * margin;
  const usableLen = config.lengthIn - 2 * margin;
  const placements: PlacementMap = {};
  const unplaced: NestPiece[] = [];
  if (usableW <= 0 || usableLen <= 0) return { placements, unplaced: [...pieces] };

  const byFilm = new Map<string, NestPiece[]>();
  for (const p of pieces) {
    const list = byFilm.get(p.filmKey) || [];
    list.push(p);
    byFilm.set(p.filmKey, list);
  }

  for (const [filmKey, filmPieces] of byFilm) {
    const bins: Bin[] = [];
    const ensureBin = (i: number) => {
      while (bins.length <= i) bins.push(newBin(usableLen, usableW, spacing));
      return bins[i];
    };
    for (const { piece, placement } of existing) {
      if (piece.filmKey !== filmKey) continue;
      // Clamp the roll index — a hand-edited or corrupt snapshot must not
      // allocate bins unboundedly or crash the page.
      const roll = Math.min(MAX_ROLLS_PER_FILM - 1, Math.max(0, Math.floor(placement.roll) || 0));
      const r = placedRect(piece, placement);
      occupy(ensureBin(roll), { x: r.x - margin, y: r.y - margin, w: r.w, h: r.h }, spacing);
    }

    // Longest side first, biggest first — the classic ordering that keeps
    // big panels from getting stranded by early small placements.
    const ordered = [...filmPieces].sort((a, b) =>
      Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);

    for (const piece of ordered) {
      let best: { roll: number; x: number; y: number; rot: 0 | 90; score: [number, number, number, number] } | null = null;
      const consider = (roll: number, bin: Bin) => {
        for (const fr of bin.free) {
          for (const rot of [0, 90] as const) {
            if (rot === 90 && Math.abs(piece.w - piece.h) < EPS) continue;
            const { w: pw, h: ph } = placedSize(piece, rot);
            if (pw + spacing > fr.w + EPS || ph + spacing > fr.h + EPS) continue;
            // Grow the roll's used length as little as possible, then sit
            // as close to the start and the reference edge as we can.
            const score: [number, number, number, number] =
              [roll, Math.max(bin.extent, fr.x + pw), fr.x, fr.y];
            if (!best || cmpScore(score, best.score) < 0) {
              best = { roll, x: fr.x, y: fr.y, rot, score };
            }
          }
        }
      };
      bins.forEach((bin, i) => consider(i, bin));
      if (!best && bins.length < MAX_ROLLS_PER_FILM) {
        const bin = ensureBin(bins.length);
        consider(bins.length - 1, bin);
      }
      if (!best) { unplaced.push(piece); continue; }
      const b = best as { roll: number; x: number; y: number; rot: 0 | 90 };
      const { w: pw, h: ph } = placedSize(piece, b.rot);
      occupy(bins[b.roll], { x: b.x, y: b.y, w: pw, h: ph }, spacing);
      placements[piece.key] = { roll: b.roll, x: b.x + margin, y: b.y + margin, rot: b.rot };
    }
  }
  return { placements, unplaced };
}

function cmpScore(a: [number, number, number, number], b: [number, number, number, number]) {
  for (let i = 0; i < 4; i++) {
    if (Math.abs(a[i] - b[i]) > EPS) return a[i] - b[i];
  }
  return 0;
}

/**
 * Pack any new pieces into the remaining space; already-placed pieces stay
 * put. Placements for pieces that no longer exist are KEPT (they're inert —
 * usage and obstacle math only ever consult current pieces) so a transient
 * state like retyping the kit count from 12 → 1 → 15 doesn't wipe a manual
 * arrangement; Auto-Nest rebuilds the map from scratch and clears them.
 * Returns the SAME map object when nothing needed placing, so state
 * effects can cheaply no-op.
 */
export function reconcilePlacements(
  pieces: NestPiece[],
  placements: PlacementMap,
  config: RollConfig
): PlacementMap {
  const missing = pieces.filter(p => !(p.key in placements));
  if (missing.length === 0) return placements;
  const existing = pieces
    .filter(p => p.key in placements)
    .map(p => ({ piece: p, placement: placements[p.key] }));
  const { placements: added } = packPieces(missing, config, existing);
  if (Object.keys(added).length === 0) return placements;
  return { ...placements, ...added };
}

// ---------------------------------------------------------------- Usage

export interface RollStat { usedLengthIn: number; pieceCount: number }

export interface FilmUsage {
  filmKey: string;
  rolls: RollStat[];
  rollSqft: number; // billed: roll width × used length, summed over rolls
  graphicSqft: number; // actual piece footprint (with bleed)
  placedCount: number;
}

export interface RollUsage {
  films: FilmUsage[];
  unplaced: NestPiece[];
  totalRollSqft: number;
}

/**
 * What the current layout consumes. Used length per roll = far edge of the
 * furthest piece + the edge margin (the material physically cut off the
 * roll), capped at the roll length.
 */
export function computeUsage(pieces: NestPiece[], placements: PlacementMap, config: RollConfig): RollUsage {
  const films = new Map<string, { rolls: Map<number, RollStat>; graphic: number; placed: number }>();
  const unplaced: NestPiece[] = [];
  for (const p of pieces) {
    const pl = placements[p.key];
    if (!pl) { unplaced.push(p); continue; }
    const f = films.get(p.filmKey) || { rolls: new Map<number, RollStat>(), graphic: 0, placed: 0 };
    const r = placedRect(p, pl);
    const roll = f.rolls.get(pl.roll) || { usedLengthIn: 0, pieceCount: 0 };
    roll.usedLengthIn = Math.min(config.lengthIn, Math.max(roll.usedLengthIn, r.x + r.w + config.edgeMarginIn));
    roll.pieceCount++;
    f.rolls.set(pl.roll, roll);
    f.graphic += (r.w * r.h) / 144;
    f.placed++;
    films.set(p.filmKey, f);
  }
  const out: FilmUsage[] = [];
  for (const [filmKey, f] of films) {
    const rolls = [...f.rolls.entries()].sort((a, b) => a[0] - b[0]).map(([, stat]) => stat);
    out.push({
      filmKey,
      rolls,
      rollSqft: rolls.reduce((sum, r) => sum + (r.usedLengthIn * config.widthIn) / 144, 0),
      graphicSqft: f.graphic,
      placedCount: f.placed,
    });
  }
  return {
    films: out,
    unplaced,
    totalRollSqft: out.reduce((sum, f) => sum + f.rollSqft, 0),
  };
}

/**
 * Layout problems worth flagging: pieces overlapping another piece on the
 * same roll (closer than ~1/100"), and pieces hanging off the roll. Manual
 * drags are allowed to create these — the UI highlights them instead of
 * blocking the drag.
 */
export function findLayoutIssues(pieces: NestPiece[], placements: PlacementMap, config: RollConfig) {
  const overlapping = new Set<string>();
  const outOfBounds = new Set<string>();
  const TOL = 0.01;
  const groups = new Map<string, { piece: NestPiece; rect: Rect }[]>();
  for (const p of pieces) {
    const pl = placements[p.key];
    if (!pl) continue;
    const rect = placedRect(p, pl);
    if (rect.x < -TOL || rect.y < -TOL || rect.x + rect.w > config.lengthIn + TOL || rect.y + rect.h > config.widthIn + TOL) {
      outOfBounds.add(p.key);
    }
    const groupKey = `${p.filmKey}#${pl.roll}`;
    const list = groups.get(groupKey) || [];
    list.push({ piece: p, rect });
    groups.set(groupKey, list);
  }
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].rect, b = list[j].rect;
        if (a.x + a.w > b.x + TOL && b.x + b.w > a.x + TOL && a.y + a.h > b.y + TOL && b.y + b.h > a.y + TOL) {
          overlapping.add(list[i].piece.key);
          overlapping.add(list[j].piece.key);
        }
      }
    }
  }
  return { overlapping, outOfBounds };
}

export const fmtFtIn = (inches: number) => {
  const total = Math.max(0, Math.round(inches * 10) / 10);
  const ft = Math.floor(total / 12);
  const rem = Math.round((total - ft * 12) * 10) / 10;
  if (ft === 0) return `${rem}"`;
  return rem > 0 ? `${ft}' ${rem}"` : `${ft}'`;
};

// ---------------------------------------------------------------- Polygons
// Helpers for the freeform shape tool. Points are in whatever unit the
// caller uses (template-image pixels or inches) — area comes back in that
// unit squared.

export interface Pt { x: number; y: number }

export function polygonArea(points: Pt[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function polygonPerimeter(points: Pt[]): number {
  if (points.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

/**
 * Area of a shape after growing it by `bleed` on every side:
 * A + P·b + πb² — exact for convex shapes, a slight (safe) overestimate
 * for concave ones. Matches how box bleed is billed (each dimension grows
 * by 2×bleed).
 */
export function offsetArea(area: number, perimeter: number, bleed: number): number {
  if (bleed <= 0) return area;
  return area + perimeter * bleed + Math.PI * bleed * bleed;
}

/**
 * True when the closed outline crosses itself (a "bowtie"). The shoelace
 * formula cancels the overlapping lobes of such a shape, so a crossed
 * outline would silently under-bill — the drawing tools refuse to close
 * one and flag it if vertex edits create one.
 */
export function polygonSelfIntersects(points: Pt[]): boolean {
  const n = points.length;
  if (n < 4) return false;
  const seg = (i: number) => [points[i], points[(i + 1) % n]] as const;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Skip the shared-vertex neighbours (and the first/last wrap pair).
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const [a, b] = seg(i), [c, d] = seg(j);
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const orient = (p: Pt, q: Pt, r: Pt) => {
    const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return Math.abs(v) < 1e-9 ? 0 : Math.sign(v);
  };
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true;
  const onSeg = (p: Pt, q: Pt, r: Pt) =>
    orient(p, q, r) === 0 &&
    Math.min(p.x, q.x) - 1e-9 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-9 &&
    Math.min(p.y, q.y) - 1e-9 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-9;
  return onSeg(a, b, c) || onSeg(a, b, d) || onSeg(c, d, a) || onSeg(c, d, b);
}
