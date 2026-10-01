// Sizing decals off a customer's proof.
//
// A proof is a flat picture: a vehicle outline with the artwork placed on it,
// usually a size table somewhere on the page, and no text layer to read. The
// rep knows the vehicle (they pick its template), the template knows the
// wheelbase, and the proof shows both wheels — so the distance between the
// wheel centres is a ruler for everything drawn on that side view. The
// pieces, in order:
//
//   1. Claude reads the page (api/wrap-quote/read-proof): which views it
//      shows, the size table, and a rough box round each decal. Its boxes
//      are approximate — a few percent out either way.
//   2. findWheels() finds the two road wheels on the side view: the lowest
//      pair of large dark round blobs spaced like a wheelbase.
//   3. snapBox() tightens each rough box to the artwork inside it, dropping
//      the hairline body lines (door seams, creases, outline) a loose box
//      inevitably catches.
//   4. buildProofBoxes() turns the lot into Photo-mode coverage boxes with a
//      line calibration along the wheelbase, so the Estimator's existing
//      photo pipeline measures, prices, nests and saves them.
//
// Where the proof prints a size, that size wins (owner decision 2026-10-01):
// drawings are not always to scale — a logo blown up for legibility, an
// arrow drawn long — and the printed number is what the customer approved.
// The measured number is kept alongside so the review screen can show when
// the two disagree.
//
// Image routines work on plain RGBA buffers (what canvas getImageData gives)
// and are unit-tested on synthetic pictures in proof-sizing.test.ts.

import { measureRect, type PhotoCalibration, type PixelRect } from './photo-scale';
import {
  measureBoxes,
  nextCoverageColor,
  type CoverageBox,
  type ProofLegendRow,
} from './coverage-proof';

// ───────────────────────── What the reader returns ─────────────────────────

/** A box as a fraction of the page: x, y, w, h all in 0..1. */
export interface FracBox { x: number; y: number; w: number; h: number }

export type ProofViewKind = 'driver_side' | 'passenger_side' | 'front' | 'rear' | 'roof' | 'hood' | 'other';

export const PROOF_VIEW_KINDS: ProofViewKind[] = ['driver_side', 'passenger_side', 'front', 'rear', 'roof', 'hood', 'other'];

export interface ProofView {
  kind: ProofViewKind;
  label: string;
  box: FracBox;
}

/** One row of the proof's printed size table. Either dimension may be missing
 *  ("24 in tall" says nothing about the width). */
export interface ProofSizeRow {
  name: string;
  width_in: number | null;
  height_in: number | null;
  qty: number | null;
}

export interface ProofDecal {
  name: string;
  /** Index into `views`, or null when the reader couldn't place it in one. */
  view: number | null;
  box: FracBox;
  /** Index into `size_table` when the reader paired the decal with a row. */
  size_table_index: number | null;
}

export interface ProofReadResult {
  page_title: string | null;
  views: ProofView[];
  size_table: ProofSizeRow[];
  decals: ProofDecal[];
}

const MAX_VIEWS = 12;
const MAX_SIZE_ROWS = 60;
const MAX_DECALS = 80;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const posNum = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function sanitizeFracBox(raw: any): FracBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x), y = Number(raw.y), w = Number(raw.w), h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  const x0 = clamp01(x), y0 = clamp01(y);
  const x1 = clamp01(x + w), y1 = clamp01(y + h);
  const bw = x1 - x0, bh = y1 - y0;
  // Anything thinner than 0.2% of the page is a line, not a decal.
  if (bw < 0.002 || bh < 0.002) return null;
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  return { x: r6(x0), y: r6(y0), w: r6(bw), h: r6(bh) };
}

/**
 * Make the model's JSON safe to use: every number finite and in range, every
 * index pointing at something, junk rows dropped. Shared by the API route
 * (before it answers) and the client (before it trusts the answer).
 */
export function sanitizeProofRead(raw: any): ProofReadResult {
  const src = raw && typeof raw === 'object' ? raw : {};
  const views: ProofView[] = [];
  for (const v of Array.isArray(src.views) ? src.views : []) {
    const box = sanitizeFracBox(v?.box);
    if (!box) continue;
    const kind = PROOF_VIEW_KINDS.includes(v?.kind) ? (v.kind as ProofViewKind) : 'other';
    views.push({ kind, label: str(v?.label, 60) || viewKindLabel(kind), box });
    if (views.length >= MAX_VIEWS) break;
  }
  const size_table: ProofSizeRow[] = [];
  for (const r of Array.isArray(src.size_table) ? src.size_table : []) {
    const name = str(r?.name, 80);
    const width_in = posNum(r?.width_in), height_in = posNum(r?.height_in);
    if (!name || (width_in == null && height_in == null)) continue;
    const qty = posNum(r?.qty);
    size_table.push({ name, width_in, height_in, qty: qty ? Math.round(qty) : null });
    if (size_table.length >= MAX_SIZE_ROWS) break;
  }
  const decals: ProofDecal[] = [];
  for (const d of Array.isArray(src.decals) ? src.decals : []) {
    const box = sanitizeFracBox(d?.box);
    if (!box) continue;
    const view = Number.isInteger(d?.view) && d.view >= 0 && d.view < views.length ? d.view : null;
    const sti = Number.isInteger(d?.size_table_index) && d.size_table_index >= 0 && d.size_table_index < size_table.length
      ? d.size_table_index : null;
    decals.push({ name: str(d?.name, 80) || `Decal ${decals.length + 1}`, view, box, size_table_index: sti });
    if (decals.length >= MAX_DECALS) break;
  }
  return { page_title: str(src.page_title, 80) || null, views, size_table, decals };
}

export function viewKindLabel(kind: ProofViewKind): string {
  switch (kind) {
    case 'driver_side': return 'Driver side';
    case 'passenger_side': return 'Passenger side';
    case 'front': return 'Front';
    case 'rear': return 'Rear';
    case 'roof': return 'Roof';
    case 'hood': return 'Hood';
    default: return 'View';
  }
}

export const isSideView = (kind: ProofViewKind) => kind === 'driver_side' || kind === 'passenger_side';

/** A fractional box in page pixels. */
export function fracToRect(b: FracBox, width: number, height: number): PixelRect {
  return { x: b.x * width, y: b.y * height, w: b.w * width, h: b.h * height };
}

// ───────────────────────── Pixels ─────────────────────────

/** An RGBA buffer, as canvas getImageData returns. */
export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

interface IntRect { x: number; y: number; w: number; h: number }

/** Integer rect inside the image; null when nothing is left. */
function clampRect(r: PixelRect, width: number, height: number): IntRect | null {
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(width, Math.round(r.x + r.w));
  const y1 = Math.min(height, Math.round(r.y + r.h));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

interface Component {
  minX: number; minY: number; maxX: number; maxY: number;
  area: number;
}

/**
 * Connected-component labelling of a binary mask. Labels start at 1; 0 is
 * background. Iterative flood fill with an explicit stack — a recursive one
 * blows the call stack on a page-sized mask.
 */
export function labelComponents(mask: Uint8Array, w: number, h: number, eightConnected: boolean): { labels: Int32Array; comps: Component[] } {
  const n = w * h;
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  const comps: Component[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = comps.length + 1;
    const c: Component = { minX: w, minY: h, maxX: -1, maxY: -1, area: 0 };
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      c.area++;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      const x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x;
      const y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (!eightConnected && xx !== x && yy !== y) continue;
          const j = yy * w + xx;
          if (mask[j] && !labels[j]) { labels[j] = id; stack[sp++] = j; }
        }
      }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/**
 * How many set pixels sit in the (2r+1)² window round each pixel, via a
 * summed-area table. Outside the image counts as empty, which is what makes
 * erosion fail at the border exactly as scipy's binary_opening does.
 */
function windowCounts(mask: Uint8Array, w: number, h: number, r: number): Int32Array {
  const W = w + 1;
  const sat = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    const base = y * w, satBase = (y + 1) * W, prev = y * W;
    for (let x = 0; x < w; x++) {
      row += mask[base + x];
      sat[satBase + x + 1] = sat[prev + x + 1] + row;
    }
  }
  const out = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    const top = y0 * W, bottom = (y1 + 1) * W;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      out[y * w + x] = sat[bottom + x1 + 1] - sat[top + x1 + 1] - sat[bottom + x0] + sat[top + x0];
    }
  }
  return out;
}

/** Morphological opening with a k×k square: erode, then dilate. */
function openMask(mask: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const r = (k - 1) >> 1;
  const full = k * k;
  const counts = windowCounts(mask, w, h, r);
  const eroded = new Uint8Array(w * h);
  for (let i = 0; i < eroded.length; i++) eroded[i] = counts[i] === full ? 1 : 0;
  const grown = windowCounts(eroded, w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = grown[i] > 0 ? 1 : 0;
  return out;
}

export interface Wheel { x: number; y: number; r: number }

export interface WheelPair {
  /** Left wheel, then right wheel, in page pixels. */
  a: Wheel;
  b: Wheel;
  /** Darkness threshold that found them — lower is cleaner. */
  thresh: number;
}

/**
 * Find the two road wheels in a side view: the lowest pair of large, dark,
 * roughly round blobs sitting at the same height and spaced like a
 * wheelbase (5–13 tyre radii apart). Thin outline strokes are opened away
 * first so a tyre ring can't glue itself to the body outline. Tried at a few
 * darkness thresholds, since tyres are black on one proof and dark grey on
 * another. null when no pair is found — the rep sets the scale by hand.
 */
export function findWheels(img: RgbaImage, crop: PixelRect, minRadiusFrac = 0.04): WheelPair | null {
  const c = clampRect(crop, img.width, img.height);
  if (!c || c.w < 40 || c.h < 40) return null;
  const { w, h } = c;
  const minR = minRadiusFrac * h;
  const k = Math.max(3, Math.floor(h / 110)) | 1;
  // Brightest channel per pixel, once; "dark" is then a threshold on it.
  const bright = new Uint8Array(w * h);
  const data = img.data, stride = img.width * 4;
  for (let y = 0; y < h; y++) {
    let p = (c.y + y) * stride + c.x * 4;
    const row = y * w;
    for (let x = 0; x < w; x++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      bright[row + x] = r > g ? (r > b ? r : b) : (g > b ? g : b);
    }
  }
  for (const thresh of [60, 90, 120, 150]) {
    const dark = new Uint8Array(w * h);
    for (let i = 0; i < dark.length; i++) dark[i] = bright[i] < thresh ? 1 : 0;
    const opened = openMask(dark, w, h, k);
    const { comps } = labelComponents(opened, w, h, false);
    const cands: Wheel[] = [];
    for (const cp of comps) {
      const bw = cp.maxX - cp.minX + 1, bh = cp.maxY - cp.minY + 1;
      const r = Math.max(bw, bh) / 2;
      if (r < minR) continue;
      const aspect = bw / bh;
      if (!(aspect > 0.6 && aspect < 1.6)) continue;
      if (cp.area / (bw * bh) < 0.2) continue;
      cands.push({ x: (cp.minX + cp.maxX + 1) / 2, y: (cp.minY + cp.maxY + 1) / 2, r });
    }
    let best: { y: number; pair: [Wheel, Wheel] } | null = null;
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const p = cands[i], q = cands[j];
        const r = Math.max(p.r, q.r);
        const dx = Math.abs(p.x - q.x);
        const ratio = p.r / q.r;
        if (Math.abs(p.y - q.y) < 0.3 * r && dx > 5 * r && dx < 13 * r && ratio > 0.7 && ratio < 1.4) {
          const y = (p.y + q.y) / 2;
          // Lowest on the page wins: a roof rack or a forklift in the
          // artwork sits above the road wheels.
          if (!best || y > best.y) best = { y, pair: p.x <= q.x ? [p, q] : [q, p] };
        }
      }
    }
    if (best) {
      const toPage = (wh: Wheel): Wheel => ({ x: wh.x + c.x, y: wh.y + c.y, r: wh.r });
      return { a: toPage(best.pair[0]), b: toPage(best.pair[1]), thresh };
    }
  }
  return null;
}

/** Thickness, in px, of the body lines a view of this height is drawn with. */
export const bodyLineThickness = (viewHeightPx: number) => Math.min(10, Math.max(2, viewHeightPx / 150));

/** Anything this far (per channel) from the box's own background is ink. */
const INK_THRESHOLD = 45;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Tighten a rough box to the graphic inside it. Everything that differs from
 * the box's own background (the median colour of its border ring) is ink;
 * ink components that are hairline-thin — body outlines, door seams,
 * creases, leader lines — are dropped; the box becomes the bounding box of
 * what is left. Thin-but-short bits sitting next to kept ink are letters
 * ("l", "-", "i"), not body lines, and are taken back.
 *
 * `lineT` is the body-line thickness for this view (bodyLineThickness).
 * Returns the rough box unchanged when nothing survives — a decal lighter
 * than the ink threshold, or a box over blank panel.
 */
export function snapBox(img: RgbaImage, rect: PixelRect, lineT: number): PixelRect {
  const c = clampRect(rect, img.width, img.height);
  if (!c || c.w < 4 || c.h < 4) return rect;
  const { w, h } = c;
  const data = img.data, stride = img.width * 4;
  const px = (x: number, y: number) => (c.y + y) * stride + (c.x + x) * 4;

  // Background: per-channel median of the pixels on the box's border.
  const ring: [number[], number[], number[]] = [[], [], []];
  const take = (x: number, y: number) => {
    const p = px(x, y);
    ring[0].push(data[p]); ring[1].push(data[p + 1]); ring[2].push(data[p + 2]);
  };
  for (let x = 0; x < w; x++) { take(x, 0); take(x, h - 1); }
  for (let y = 0; y < h; y++) { take(0, y); take(w - 1, y); }
  const bg = [median(ring[0]), median(ring[1]), median(ring[2])];

  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let p = px(0, y);
    const row = y * w;
    for (let x = 0; x < w; x++, p += 4) {
      const d0 = Math.abs(data[p] - bg[0]), d1 = Math.abs(data[p + 1] - bg[1]), d2 = Math.abs(data[p + 2] - bg[2]);
      ink[row + x] = (d0 > INK_THRESHOLD || d1 > INK_THRESHOLD || d2 > INK_THRESHOLD) ? 1 : 0;
    }
  }

  const { labels, comps } = labelComponents(ink, w, h, true);
  const keep = new Uint8Array(w * h);
  const smallComp = new Uint8Array(comps.length + 1);
  let anyKept = false;
  // Hairline strokes vanish under an opening this wide; artwork survives it.
  const k = Math.max(3, Math.round(1.6 * lineT)) | 1;
  comps.forEach((cp, idx) => {
    const id = idx + 1;
    const bw = cp.maxX - cp.minX + 1, bh = cp.maxY - cp.minY + 1;
    const fill = cp.area / (bw * bh);
    const thin = Math.min(bw, bh) <= 1.6 * lineT || (fill < 0.08 && Math.max(bw, bh) > 6 * lineT);
    if (thin) {
      if (Math.max(bw, bh) < 5 * lineT) smallComp[id] = 1;
      return;
    }
    // A body line running THROUGH a decal is part of the decal's component,
    // so the component test above can't shed it. Open the component: if most
    // of it survives it is solid artwork (a logo, bold lettering) and the
    // thin protrusions are seams and creases — keep only the solid core.
    // If little survives it is thin-stroked artwork (light lettering) and
    // the whole component stays, body line and all.
    const mask = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const row = (cp.minY + y) * w + cp.minX;
      for (let x = 0; x < bw; x++) if (labels[row + x] === id) mask[y * bw + x] = 1;
    }
    const core = openMask(mask, bw, bh, k);
    let coreArea = 0;
    for (let i = 0; i < core.length; i++) coreArea += core[i];
    const src = coreArea >= 0.5 * cp.area ? core : mask;
    for (let y = 0; y < bh; y++) {
      const row = (cp.minY + y) * w + cp.minX;
      for (let x = 0; x < bw; x++) if (src[y * bw + x]) keep[row + x] = 1;
    }
    anyKept = true;
  });
  if (!anyKept) return rect;

  // Small thin bits within 2 line-widths of kept ink are letters — back in.
  const reach = Math.max(1, Math.round(2 * lineT));
  const near = windowCounts(keep, w, h, reach);
  const takeBack = new Uint8Array(comps.length + 1);
  for (let i = 0; i < keep.length; i++) {
    const id = labels[i];
    if (id && smallComp[id] && near[i] > 0) takeBack[id] = 1;
  }

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!keep[i] && !takeBack[labels[i]]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return rect;
  return { x: c.x + minX, y: c.y + minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// ───────────────────────── Size table matching ─────────────────────────

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Which size-table row a decal name refers to, when the reader didn't say:
 * an exact name, then one containing the other, then the row sharing the
 * most words (at least half of them). null when nothing is close.
 */
export function matchSizeRow(name: string, rows: ProofSizeRow[]): number | null {
  const q = normName(name);
  if (!q || rows.length === 0) return null;
  const names = rows.map(r => normName(r.name));
  const exact = names.findIndex(n => n === q);
  if (exact >= 0) return exact;
  const contains = names.findIndex(n => n && (n.includes(q) || q.includes(n)));
  if (contains >= 0) return contains;
  const qt = new Set(q.split(' '));
  let best = -1, bestScore = 0;
  names.forEach((n, i) => {
    const t = new Set(n.split(' ').filter(Boolean));
    if (t.size === 0) return;
    let shared = 0;
    for (const word of qt) if (t.has(word)) shared++;
    const score = shared / Math.max(qt.size, t.size);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return bestScore >= 0.5 ? best : null;
}

// ───────────────────────── Putting it together ─────────────────────────

export interface BuildProofArgs {
  img: RgbaImage;
  read: ProofReadResult;
  /** The chosen template's wheelbase; null leaves the page unscaled. */
  wheelbaseIn: number | null;
  /** Film given to every box — the one the rep last picked, as Photo mode does. */
  defaultFilmId: string | null;
  /** Row ids come from here so tests are deterministic. */
  newId?: () => string;
}

export interface BuiltProof {
  boxes: CoverageBox[];
  calibration: PhotoCalibration | null;
  legend: ProofLegendRow[];
  wheels: WheelPair | null;
  /** Plain-language notes for the rep: what was found, what wasn't. */
  notes: string[];
}

/** Rough boxes are grown this much each side before snapping, so a reader
 *  box that clipped the artwork's edge still catches all of it. */
const SNAP_PAD = 0.04;
const MIN_PAD_PX = 4;

/** A snap that keeps under this share of the rough box found a speck, not
 *  the decal (a pale graphic under the ink threshold) — keep the reader's box. */
const MIN_SNAP_AREA_SHARE = 0.08;

/**
 * Turn one read page into Photo-mode boxes: wheels → scale, rough boxes →
 * snapped boxes, size-table rows → the sizes that win. The page's own
 * measurement fills in wherever the table is silent.
 */
export function buildProofBoxes(args: BuildProofArgs): BuiltProof {
  const { img, read, wheelbaseIn, defaultFilmId } = args;
  const newId = args.newId || (() => crypto.randomUUID());
  const notes: string[] = [];
  const W = img.width, H = img.height;

  const legend: ProofLegendRow[] = read.size_table.map(r => ({
    id: newId(), name: r.name, width_in: r.width_in, height_in: r.height_in, qty: r.qty,
  }));

  // Scale: the first side view whose wheels are found.
  let wheels: WheelPair | null = null;
  let calibration: PhotoCalibration | null = null;
  const sideViews = read.views.filter(v => isSideView(v.kind));
  for (const v of sideViews) {
    const rect = fracToRect(v.box, W, H);
    wheels = findWheels(img, rect) || findWheels(img, growRect(rect, 0.1, W, H));
    if (wheels) break;
  }
  if (wheels) {
    if (wheelbaseIn && wheelbaseIn > 0) {
      calibration = { line: { x1: wheels.a.x, y1: wheels.a.y, x2: wheels.b.x, y2: wheels.b.y, inches: wheelbaseIn } };
    } else {
      notes.push('Both wheels found, but the vehicle has no wheelbase on file — pick a template with one, or type the wheelbase, to measure the drawing.');
    }
  } else if (sideViews.length === 0) {
    notes.push('No side view on this page, so nothing is measured off the drawing; sizes come from the size table.');
  } else {
    notes.push('Could not find both wheels on the side view. Use Known length to drag between the wheel centres, or type sizes.');
  }

  const boxes: CoverageBox[] = read.decals.map((d, i) => {
    const view = d.view != null ? read.views[d.view] : null;
    const viewRect = view ? fracToRect(view.box, W, H) : null;
    const lineT = bodyLineThickness(viewRect ? viewRect.h : H * 0.5);
    const rough = fracToRect(d.box, W, H);
    const padded = growRect(rough, SNAP_PAD, W, H, MIN_PAD_PX);
    let rect = snapBox(img, padded, lineT);
    if (rect.w * rect.h < MIN_SNAP_AREA_SHARE * rough.w * rough.h) rect = rough;

    const rowIdx = d.size_table_index ?? matchSizeRow(d.name, read.size_table);
    const row = rowIdx != null ? legend[rowIdx] : null;
    const box: CoverageBox = {
      id: newId(),
      label: d.name,
      color: nextCoverageColor(i),
      rect,
      qty: 1,
      substrate_id: defaultFilmId,
      legend: row ? { row_id: row.id, name: row.name, width_in: row.width_in, height_in: row.height_in } : null,
    };
    if (row) applyLegendSize(box, calibration);
    return box;
  });

  const measured = measureBoxes(boxes, calibration);
  const fromTable = measured.filter(b => b.legend && b.manual).length;
  const sized = measured.filter(b => b.width_in && b.height_in).length;
  if (measured.length > 0) {
    notes.unshift(`${measured.length} decal${measured.length === 1 ? '' : 's'} found: ${fromTable} sized from the size table, ${sized - fromTable} measured off the drawing${measured.length - sized > 0 ? `, ${measured.length - sized} still need a size` : ''}.`);
  } else {
    notes.unshift('No decals found on this page.');
  }
  return { boxes: measured, calibration, legend, wheels, notes };
}

/**
 * Give a box the size its size-table row prints. A row with one dimension
 * borrows the other from the drawing (when there is a scale), so a "24 in
 * tall" lettering line still prices. Marked `manual` so recalibrating the
 * page never overwrites a printed number.
 */
export function applyLegendSize(box: CoverageBox, cal: PhotoCalibration | null): CoverageBox {
  const l = box.legend;
  if (!l || (l.width_in == null && l.height_in == null)) return box;
  const m = measureRect(box.rect, cal);
  box.manual = true;
  box.measured_by = null;
  box.width_in = l.width_in ?? m?.widthIn ?? null;
  box.height_in = l.height_in ?? m?.heightIn ?? null;
  box.area_in2 = box.width_in && box.height_in ? box.width_in * box.height_in : null;
  return box;
}

/** Does this box currently carry its size-table size (rather than a measured or typed one)? */
export function usesLegendSize(box: CoverageBox): boolean {
  const l = box.legend;
  if (!l || !box.manual) return false;
  if (l.width_in != null && box.width_in !== l.width_in) return false;
  if (l.height_in != null && box.height_in !== l.height_in) return false;
  return l.width_in != null || l.height_in != null;
}

/**
 * Size-table rows no box on any page is using yet. A multi-page proof prints
 * its table on every page, so the same row has one id per page: a box using
 * page 2's copy counts as using page 1's too (same name and sizes).
 */
export function unplacedLegendRows(legend: ProofLegendRow[], boxes: CoverageBox[]): ProofLegendRow[] {
  const key = (r: { name: string; width_in: number | null; height_in: number | null }) =>
    `${normName(r.name)}|${r.width_in ?? ''}|${r.height_in ?? ''}`;
  const usedIds = new Set(boxes.map(b => b.legend?.row_id).filter(Boolean));
  const usedKeys = new Set(boxes.filter(b => b.legend).map(b => key(b.legend!)));
  return legend.filter(r => !usedIds.has(r.id) && !usedKeys.has(key(r)));
}

function growRect(r: PixelRect, frac: number, W: number, H: number, minPx = 0): PixelRect {
  const dx = Math.max(minPx, r.w * frac), dy = Math.max(minPx, r.h * frac);
  const x0 = Math.max(0, r.x - dx), y0 = Math.max(0, r.y - dy);
  const x1 = Math.min(W, r.x + r.w + dx), y1 = Math.min(H, r.y + r.h + dy);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
