// Photo coverage proofs: boxes drawn straight onto a photo of the customer's
// own vehicle, so a quote can show "this is what gets wrapped" without a 1:20
// outline template existing for that vehicle. Deliberately NOT measurements —
// a box here carries a label and a color, no inches and no pricing (see
// migrations/315-wrap-quote-photo-proof.sql); sizing stays the template
// estimator's job.
//
// Geometry is stored in photo pixel coordinates (the same convention the
// template estimator uses for its shapes) so boxes redraw at any display size
// and rasterize identically to what was drawn on screen.

export interface CoverageBox {
  id: string;
  label: string;
  /** 6-digit hex — the on-photo outline/fill color. */
  color: string;
  rect: { x: number; y: number; w: number; h: number };
}

/** Same palette the estimator gives films, so proofs read like the diagrams. */
export const COVERAGE_COLORS = [
  '#06b6d4', '#a78bfa', '#f472b6', '#4ade80',
  '#fb923c', '#facc15', '#60a5fa', '#f87171',
];

export const nextCoverageColor = (used: number) => COVERAGE_COLORS[used % COVERAGE_COLORS.length];

/** Longest edge of an uploaded photo, in pixels, after downscaling. */
const MAX_PHOTO_EDGE = 2200;

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
    const label = (b.label || '').trim();
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
    boxes.push({
      id: typeof b.id === 'string' && b.id ? b.id : crypto.randomUUID(),
      label: typeof b.label === 'string' ? b.label : '',
      color: /^#[0-9a-fA-F]{6}$/.test(b?.color) ? b.color : COVERAGE_COLORS[0],
      rect,
    });
  }
  return boxes;
}
