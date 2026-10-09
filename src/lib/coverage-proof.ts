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

import { badgeRadius, badgeSpots, type BadgeSpot, type PartRow } from './proof-parts';
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
  /** Vinyl price for one of this panel, typed by the rep; null = by area. */
  price_override?: number | null;
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
  /** The size-table row on a customer proof this decal was paired with
   *  (src/lib/proof-sizing.ts). When the box is `manual` and carries these
   *  numbers, the printed size is what's being priced. */
  legend?: BoxLegend | null;
}

/** A printed size from a proof's size table, attached to the box it sizes. */
export interface BoxLegend {
  /** ProofLegendRow.id on the page that listed it, so unplaced rows can be told apart. */
  row_id: string | null;
  name: string;
  width_in: number | null;
  height_in: number | null;
}

/** One row of a customer proof's size table, as read off the page. */
export interface ProofLegendRow {
  id: string;
  name: string;
  width_in: number | null;
  height_in: number | null;
  qty: number | null;
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
  /** A page of the customer's proof, sized by the proof reader, rather than
   *  a photo the rep took. Reopening a quote with one restores the Customer
   *  Proof surface. */
  source?: 'customer_proof' | null;
  /** The size table read off this page (customer proofs only). */
  legend?: ProofLegendRow[] | null;
  /** Where the proof reader found the two wheel centres, so a change of
   *  vehicle (wheelbase) can re-scale the page without re-reading it. */
  wheel_line?: { x1: number; y1: number; x2: number; y2: number } | null;
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

export const LABEL_FONT_FAMILY = "-apple-system, 'Segoe UI', Roboto, sans-serif";

/**
 * Label text size on the saved proof picture, in photo pixels: about 1% of
 * the photo's width, so a tag reads when the picture is viewed whole without
 * burying the artwork it points at. (It was 1/48, which on a proof sheet drew
 * tags wider than the decals.)
 */
export const savedLabelFontSize = (photoW: number) => Math.max(11, Math.round(photoW / 100));

/**
 * Where a label pill goes: above the box when there's room, otherwise tucked
 * inside its top edge, and slid left so it never runs off the photo.
 */
export function labelPill(rect: PixelRect, fontSize: number, textW: number, photoW: number, gap = 0) {
  const padX = fontSize * 0.45, padY = fontSize * 0.3;
  const w = textW + padX * 2, h = fontSize + padY * 2;
  const x = Math.max(0, Math.min(rect.x, photoW - w));
  const y = rect.y - h - gap > 0 ? rect.y - h - gap : rect.y + gap;
  return { x, y, w, h, padX };
}

/** Number badge colors on the customer's picture — dark with a white rim reads on any artwork. */
export const BADGE_FILL = '#111827';
export const BADGE_RIM = '#ffffff';

/** Table text size under the saved picture, in photo pixels. */
export const partsTableFontSize = (photoW: number) => Math.max(14, Math.round(photoW / 75));

/** Height the parts table adds under a picture `photoW` wide with `rows` rows. */
export function partsTableHeight(photoW: number, rows: number): number {
  if (rows === 0) return 0;
  const f = partsTableFontSize(photoW);
  return Math.round(f * 2.2 /* title */ + f * 2 * (rows + 1) /* header + rows */ + f * 1.2 /* bottom pad */);
}

function paintBadges(ctx: CanvasRenderingContext2D, spots: BadgeSpot[], w: number) {
  const r = badgeRadius(w);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const s of spots) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = BADGE_FILL;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.18);
    ctx.strokeStyle = BADGE_RIM;
    ctx.stroke();
    const digits = String(s.number).length;
    ctx.font = `700 ${Math.round(r * (digits > 1 ? 1.05 : 1.25))}px ${LABEL_FONT_FAMILY}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(String(s.number), s.x, s.y + r * 0.06);
  }
  ctx.textAlign = 'left';
}

/** Shorten `text` with an ellipsis until it fits `maxW` at the current font. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** Column x positions (fractions of the width) shared by the canvas and the preview table. */
export const PARTS_TABLE_COLUMNS = { part: 0.07, size: 0.56, film: 0.72, qty: 0.95 } as const;

function paintPartsTable(ctx: CanvasRenderingContext2D, rows: PartRow[], w: number, top: number) {
  const f = partsTableFontSize(w);
  const pad = Math.round(w * 0.03);
  const inner = w - pad * 2;
  const col = (k: keyof typeof PARTS_TABLE_COLUMNS) => pad + inner * PARTS_TABLE_COLUMNS[k];
  const rowH = f * 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, top, w, partsTableHeight(w, rows.length));
  ctx.textBaseline = 'middle';
  let y = top + f * 1.3;
  ctx.font = `700 ${Math.round(f * 1.15)}px ${LABEL_FONT_FAMILY}`;
  ctx.fillStyle = '#111827';
  ctx.fillText('Parts on this proof', pad, y);
  y += f * 0.9;
  // Header band.
  ctx.fillStyle = '#f3f4f6';
  ctx.fillRect(pad, y, inner, rowH);
  ctx.font = `600 ${Math.round(f * 0.85)}px ${LABEL_FONT_FAMILY}`;
  ctx.fillStyle = '#4b5563';
  const mid = (yy: number) => yy + rowH / 2;
  ctx.fillText('#', pad + f * 0.4, mid(y));
  ctx.fillText('Part', col('part'), mid(y));
  ctx.fillText('Size (W × H)', col('size'), mid(y));
  ctx.fillText('Film', col('film'), mid(y));
  ctx.textAlign = 'right';
  ctx.fillText('Qty', pad + inner - f * 0.4, mid(y));
  ctx.textAlign = 'left';
  y += rowH;
  const r = f * 0.62;
  for (const row of rows) {
    // The same dark badge as on the picture, so the eye matches them.
    ctx.beginPath();
    ctx.arc(pad + f * 0.4 + r * 0.6, mid(y), r, 0, Math.PI * 2);
    ctx.fillStyle = BADGE_FILL;
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.round(r * (String(row.number).length > 1 ? 1.05 : 1.25))}px ${LABEL_FONT_FAMILY}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(String(row.number), pad + f * 0.4 + r * 0.6, mid(y) + r * 0.06);
    ctx.textAlign = 'left';
    ctx.font = `400 ${f}px ${LABEL_FONT_FAMILY}`;
    ctx.fillStyle = '#111827';
    ctx.fillText(fitText(ctx, row.name, col('size') - col('part') - f), col('part'), mid(y));
    ctx.fillText(fitText(ctx, row.size || '—', col('film') - col('size') - f), col('size'), mid(y));
    ctx.fillText(fitText(ctx, row.film || '—', col('qty') - col('film') - f * 2), col('film'), mid(y));
    ctx.textAlign = 'right';
    ctx.fillText(String(row.qty), pad + inner - f * 0.4, mid(y));
    ctx.textAlign = 'left';
    y += rowH;
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(pad, y - 1, inner, Math.max(1, f / 14));
  }
}

/**
 * Rasterize the customer's copy of a proof page: the untouched photo with a
 * number beside each piece (no boxes — those are the estimator's working
 * marks) and the parts table under it. Returns null when the photo can't be
 * loaded (offline, deleted object) — callers treat a missing proof as
 * non-fatal, exactly like the template coverage diagram.
 */
export async function renderCoverageProofBlob(
  photoUrl: string,
  boxes: CoverageBox[],
  parts: { numberOf: (boxId: string) => number | undefined; rows: PartRow[] },
): Promise<Blob | null> {
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
  canvas.height = h + partsTableHeight(w, parts.rows.length);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  paintBadges(ctx, badgeSpots(boxes, parts.numberOf, w, h), w);
  if (parts.rows.length) paintPartsTable(ctx, parts.rows, w, h);
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
      price_override: b?.price_override != null && Number.isFinite(Number(b.price_override)) && Number(b.price_override) >= 0 ? Number(b.price_override) : null,
      width_in: num(b?.width_in),
      height_in: num(b?.height_in),
      area_in2: num(b?.area_in2),
      manual: !!b?.manual,
      measured_by: b?.measured_by === 'line' || b?.measured_by === 'plane' ? b.measured_by : null,
      legend: sanitizeBoxLegend(b?.legend),
    });
  }
  return boxes;
}

const posNum = (v: any): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

function sanitizeBoxLegend(raw: any): BoxLegend | null {
  if (!raw || typeof raw !== 'object') return null;
  const width_in = posNum(raw.width_in), height_in = posNum(raw.height_in);
  if (width_in == null && height_in == null) return null;
  return {
    row_id: typeof raw.row_id === 'string' && raw.row_id ? raw.row_id : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    width_in,
    height_in,
  };
}

function sanitizeWheelLine(raw: any): PhotoProof['wheel_line'] {
  if (!raw || typeof raw !== 'object') return null;
  const l = { x1: Number(raw.x1), y1: Number(raw.y1), x2: Number(raw.x2), y2: Number(raw.y2) };
  return Object.values(l).every(Number.isFinite) ? l : null;
}

/** Size-table rows survive a round trip only with a name and at least one size. */
export function sanitizeLegendRows(raw: any): ProofLegendRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: ProofLegendRow[] = [];
  for (const r of raw) {
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    const width_in = posNum(r?.width_in), height_in = posNum(r?.height_in);
    if (!name || (width_in == null && height_in == null)) continue;
    const qty = posNum(r?.qty);
    rows.push({
      id: typeof r?.id === 'string' && r.id ? r.id : crypto.randomUUID(),
      name, width_in, height_in,
      qty: qty ? Math.round(qty) : null,
    });
  }
  return rows;
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
      source: p?.source === 'customer_proof' ? 'customer_proof' : null,
      legend: sanitizeLegendRows(p?.legend),
      wheel_line: sanitizeWheelLine(p?.wheel_line),
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
