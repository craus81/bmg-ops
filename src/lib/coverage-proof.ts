// Photo coverage proofs: boxes drawn straight onto photos of the customer's
// own vehicle, so a quote can show "this is what gets wrapped" without a 1:20
// outline template existing for that vehicle.
//
// A quote carries an ORDERED LIST of photos (migration 317) — driver side,
// passenger side, rear, roof — each with its own boxes, its own calibration,
// and its own flattened picture. Geometry is stored in that photo's pixel
// coordinates, so boxes redraw at any display size and rasterize exactly as
// drawn.
//
// Boxes are measured, not guessed: once the photo is calibrated (a known
// length, or a known rectangle's four corners — see src/lib/photo-scale.ts)
// every box carries real inches and prices like a template shape. Before
// calibration a box is still a picture, which is all the first version of
// this feature promised.

import {
  measureRect,
  type PhotoCalibration,
  type PixelRect,
} from './photo-scale';

export interface CoverageBox {
  id: string;
  label: string;
  /** 6-digit hex — the on-photo outline/fill color. */
  color: string;
  rect: PixelRect;
  /** How many of this panel the job needs (mirrors a template measurement). */
  qty?: number;
  /** wrap_substrates.id — the film this panel prints on. */
  substrate_id?: string | null;
  /** Real dimensions. Measured from the photo's calibration, unless `manual`. */
  width_in?: number | null;
  height_in?: number | null;
  /** True area of the region the box covers — under perspective this is NOT
   *  width × height, so it is stored rather than re-derived. */
  area_in2?: number | null;
  /** A person typed these numbers; recalibrating must not overwrite them. */
  manual?: boolean;
  /** Which calibration produced the numbers, so the screen can say. */
  measured_by?: 'line' | 'plane' | null;
}

export interface PhotoProof {
  id: string;
  /** Storage path of the photo itself (vehicle-templates/quote-photos/…). */
  path: string;
  /** What this view is — "Driver side", "Rear doors". Shown to the customer. */
  label: string;
  boxes: CoverageBox[];
  /** This photo's scale. Each photo is its own shot, so each calibrates
   *  separately — one van's side view tells you nothing about the rear shot. */
  calibration?: PhotoCalibration | null;
  /** Flattened photo + boxes, written at save time. */
  diagram_path?: string | null;
}

/** Same palette the estimator gives films, so proofs read like the diagrams. */
export const COVERAGE_COLORS = [
  '#06b6d4', '#a78bfa', '#f472b6', '#4ade80',
  '#fb923c', '#facc15', '#60a5fa', '#f87171',
];

export const nextCoverageColor = (used: number) => COVERAGE_COLORS[used % COVERAGE_COLORS.length];

/** Longest edge of an uploaded photo, in pixels, after downscaling. */
const MAX_PHOTO_EDGE = 2200;

/** How many photos one quote can carry — enough for every side plus spares. */
export const MAX_PHOTO_PROOFS = 12;

const loadImage = (src: string): Promise<HTMLImageElement> => {
  const img = new Image();
  // Keeps the canvas untainted so toBlob() works on the R2-hosted photo.
  img.crossOrigin = 'anonymous';
  img.src = src;
  return img.decode().then(() => img);
};

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));

/**
 * Shrink a camera photo to something an email can carry and a browser can
 * annotate smoothly. Re-encoding through a canvas also bakes in EXIF
 * orientation, so a phone photo can't come back rotated once boxes are on it.
 */
export async function prepareCoveragePhoto(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('That file doesn\'t look like an image.');
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not read that photo.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await toBlob(canvas, 'image/jpeg', 0.9);
    if (!blob) throw new Error('Could not read that photo.');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const inches = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US');

/**
 * What a box says on the picture: its name, plus its size once the photo is
 * calibrated. One definition, so the on-screen SVG and the saved JPEG can't
 * drift apart.
 */
export function boxCaption(b: CoverageBox): string {
  const label = (b.label || '').trim();
  const sized = b.width_in != null && b.height_in != null && b.width_in > 0 && b.height_in > 0
    ? `${inches(b.width_in)}" × ${inches(b.height_in)}"`
    : '';
  if (!sized) return label;
  return label ? `${label} · ${sized}` : sized;
}

/**
 * Re-measure every box against the photo's calibration. Boxes a person typed
 * dimensions into (`manual`) keep their numbers — the whole point of typing
 * one is that you know better than the photo.
 */
export function measureBoxes(boxes: CoverageBox[], cal: PhotoCalibration | null | undefined): CoverageBox[] {
  return boxes.map(b => {
    if (b.manual) return b;
    const m = measureRect(b.rect, cal);
    if (!m) return { ...b, width_in: null, height_in: null, area_in2: null, measured_by: null };
    return {
      ...b,
      width_in: m.widthIn,
      height_in: m.heightIn,
      area_in2: m.areaIn2,
      measured_by: m.source,
    };
  });
}

/**
 * Paint the boxes onto a 2D context sized to the photo's pixels. Shared by the
 * on-screen SVG's raster twin and the saved proof so the emailed picture is
 * exactly what the estimator drew.
 */
function paintBoxes(ctx: CanvasRenderingContext2D, boxes: CoverageBox[], w: number) {
  const fontSize = Math.max(13, Math.round(w / 48));
  ctx.lineWidth = Math.max(2, w / 350);
  ctx.textBaseline = 'middle';
  for (const b of boxes) {
    const { x, y, w: bw, h: bh } = b.rect;
    ctx.strokeStyle = b.color;
    ctx.fillStyle = b.color + '33';
    ctx.fillRect(x, y, bw, bh);
    ctx.strokeRect(x, y, bw, bh);
    const label = boxCaption(b);
    if (!label) continue;
    // A photo backdrop is busy, so the label rides a solid pill in the box's
    // own color — plain colored text on a photo is unreadable.
    ctx.font = `700 ${fontSize}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
    const padX = fontSize * 0.45, padY = fontSize * 0.3;
    const textW = ctx.measureText(label).width;
    const pillW = textW + padX * 2, pillH = fontSize + padY * 2;
    // Above the box when there's room, otherwise tucked inside its top edge.
    const pillX = x;
    const pillY = y - pillH - ctx.lineWidth > 0 ? y - pillH - ctx.lineWidth : y + ctx.lineWidth;
    ctx.fillStyle = b.color;
    ctx.fillRect(pillX, pillY, pillW, pillH);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, pillX + padX, pillY + pillH / 2);
  }
}

/**
 * Rasterize photo + boxes to a JPEG blob for storage. Returns null when the
 * photo can't be loaded (offline, deleted object) — callers treat a missing
 * proof as non-fatal, exactly like the template coverage diagram.
 */
export async function renderCoverageProofBlob(photoUrl: string, boxes: CoverageBox[]): Promise<Blob | null> {
  if (!photoUrl || boxes.length === 0) return null;
  let img: HTMLImageElement;
  try {
    img = await loadImage(photoUrl);
  } catch {
    return null;
  }
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  paintBoxes(ctx, boxes, w);
  return await toBlob(canvas, 'image/jpeg', 0.92);
}

const num = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Drop boxes that a hand-edited row or an aborted drag left unusable. */
export function sanitizeCoverageBoxes(raw: any): CoverageBox[] {
  if (!Array.isArray(raw)) return [];
  const boxes: CoverageBox[] = [];
  for (const b of raw) {
    const r = b?.rect;
    const rect = {
      x: Number(r?.x), y: Number(r?.y),
      w: Number(r?.w), h: Number(r?.h),
    };
    if (!Object.values(rect).every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) continue;
    const qty = num(b?.qty);
    boxes.push({
      id: typeof b.id === 'string' && b.id ? b.id : crypto.randomUUID(),
      label: typeof b.label === 'string' ? b.label : '',
      color: /^#[0-9a-fA-F]{6}$/.test(b?.color) ? b.color : COVERAGE_COLORS[0],
      rect,
      qty: qty && qty > 0 ? Math.round(qty) : 1,
      substrate_id: typeof b?.substrate_id === 'string' ? b.substrate_id : null,
      width_in: num(b?.width_in),
      height_in: num(b?.height_in),
      area_in2: num(b?.area_in2),
      manual: !!b?.manual,
      measured_by: b?.measured_by === 'line' || b?.measured_by === 'plane' ? b.measured_by : null,
    });
  }
  return boxes;
}

const sanitizePoint = (p: any) => ({ x: Number(p?.x), y: Number(p?.y) });

/** A stored calibration is only usable if its numbers survive a round trip. */
export function sanitizeCalibration(raw: any): PhotoCalibration | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: PhotoCalibration = {};
  const l = raw.line;
  if (l && [l.x1, l.y1, l.x2, l.y2, l.inches].every((n: any) => Number.isFinite(Number(n))) && Number(l.inches) > 0) {
    out.line = { x1: Number(l.x1), y1: Number(l.y1), x2: Number(l.x2), y2: Number(l.y2), inches: Number(l.inches) };
  }
  const p = raw.plane;
  if (p && Array.isArray(p.corners) && p.corners.length === 4 && Number(p.widthIn) > 0 && Number(p.heightIn) > 0) {
    const corners = p.corners.map(sanitizePoint);
    if (corners.every((c: any) => Number.isFinite(c.x) && Number.isFinite(c.y))) {
      out.plane = { corners, widthIn: Number(p.widthIn), heightIn: Number(p.heightIn) };
    }
  }
  return out.line || out.plane ? out : null;
}

/**
 * Read a quote's stored photo proofs. Also accepts the ONE-PHOTO shape the
 * first version saved (`photo_path` + `photo_boxes`), so a quote written
 * before migration 317 reopens with its proof intact even if the backfill
 * hasn't been applied to that row.
 */
export function sanitizePhotoProofs(raw: any, legacy?: { path?: string | null; boxes?: any }): PhotoProof[] {
  const rows = Array.isArray(raw) ? raw : [];
  const proofs: PhotoProof[] = [];
  for (const p of rows) {
    const path = typeof p?.path === 'string' ? p.path.trim() : '';
    if (!path) continue;
    proofs.push({
      id: typeof p?.id === 'string' && p.id ? p.id : crypto.randomUUID(),
      path,
      label: typeof p?.label === 'string' ? p.label : '',
      boxes: sanitizeCoverageBoxes(p?.boxes),
      calibration: sanitizeCalibration(p?.calibration),
      diagram_path: typeof p?.diagram_path === 'string' ? p.diagram_path : null,
    });
    if (proofs.length >= MAX_PHOTO_PROOFS) break;
  }
  if (proofs.length === 0 && legacy?.path) {
    proofs.push({
      id: crypto.randomUUID(),
      path: legacy.path,
      label: '',
      boxes: sanitizeCoverageBoxes(legacy.boxes),
      calibration: null,
      diagram_path: null,
    });
  }
  return proofs;
}

/** Every box across every photo — what pricing and the line table consume. */
export const allProofBoxes = (proofs: PhotoProof[]): CoverageBox[] =>
  proofs.flatMap(p => p.boxes);

/** Default view name when the rep doesn't type one. */
export const proofLabel = (p: PhotoProof, index: number) =>
  (p.label || '').trim() || `Photo ${index + 1}`;
