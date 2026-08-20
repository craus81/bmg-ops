// Shared types + rendering for install guides (/graphics/install-guides).
//
// A guide is a set of raster pages (1:20 template/proof exports) annotated
// with dimension lines stored in image-pixel coordinates. Each page carries
// its own px_per_in calibration (pixels per REAL vehicle inch), so labels
// stay correct however the source was rasterized. renderGuidePage() burns
// the annotations into a canvas at native resolution — the editor previews
// with SVG, but the exported PDF embeds this raster.

import { layoutDimension } from './dimension-geometry';
import { distancePx, formatDimension, realInchesFromPx, type DimUnits } from './dimension-scale';

export interface DimAnnotation {
  id: string;
  kind: 'dim' | 'note';
  /** Image-pixel endpoints. For notes: p1 = arrow target, p2 = text anchor. */
  p1: { x: number; y: number };
  p2: { x: number; y: number };
  /** Dims only: perpendicular offset of the dimension line, in image px. */
  offset: number;
  /** Optional name shown before the measurement (e.g. "Logo to door seam"). */
  label?: string;
  /** Free note; notes render it on canvas, dims list it in the schedule. */
  note?: string;
}

export interface GuidePage {
  id: string;
  name: string;
  image_path: string;
  image_w: number;
  image_h: number;
  /** Pixels per real vehicle inch; null until the page is calibrated. */
  px_per_in: number | null;
  dims: DimAnnotation[];
}

export interface GuideSection {
  id: string;
  title: string;
  body: string;
  include: boolean;
}

export interface InstallGuide {
  id: string;
  title: string;
  customer_name: string | null;
  vehicle_desc: string | null;
  scale: string;
  units: DimUnits;
  fraction_denominator: number;
  pages: GuidePage[];
  sections: GuideSection[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const DIM_COLOR = '#e11d48';
export const NOTE_COLOR = '#2563eb';

export const makeId = () => Math.random().toString(36).slice(2, 10);

/** '1:20' → 20. Falls back to 20 for anything unparseable. */
export function parseGuideScale(scale: string | null | undefined): number {
  const m = /^\s*1\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(scale || '');
  const n = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/** Label text for a dimension: "Logo to seam: 24 3/8"" or just the length. */
export function dimLabelText(
  d: DimAnnotation,
  pxPerIn: number | null,
  units: DimUnits,
  denominator: number,
): string {
  if (d.kind === 'note') return d.label || d.note || 'Note';
  const measured = pxPerIn
    ? formatDimension(realInchesFromPx(distancePx(d.p1.x, d.p1.y, d.p2.x, d.p2.y), pxPerIn), units, denominator)
    : '—';
  return d.label ? `${d.label}: ${measured}` : measured;
}

// Seeded onto every new guide; fully editable in the editor before export.
// The FleetSuite scanning section ships toggled OFF until the workflow is
// finalized — flip `include` on in the editor when it's ready.
export function defaultGuideSections(): GuideSection[] {
  return [
    {
      id: makeId(),
      title: 'How to Read This Guide',
      body:
        'All dimensions on the proof pages are ACTUAL VEHICLE dimensions in inches, measured point-to-point exactly as drawn. ' +
        'Measure from the body feature the dimension line touches (door seam, body line, wheel arch, badge, etc.) — not from the ground. ' +
        'Graphics are placed in relation to the body lines of the vehicle and are not leveled to the ground. ' +
        'Placement tolerance is 1/4" unless a dimension is marked otherwise. When a dimension references the center of an element, mark center with low-tack tape before peeling anything.',
      include: true,
    },
    {
      id: makeId(),
      title: 'Before You Start',
      body:
        'Confirm the vehicle in front of you matches the year/make/model on this guide before opening any material. ' +
        'Walk the vehicle and photograph any existing damage — rock chips, rust, peeling clear coat, dents — and report it BEFORE installing; adhesion failures over damaged paint are not warrantable. ' +
        'Clean and decontaminate every panel receiving graphics (soap wash, then a solvent wipe such as 70% isopropyl), and let panels dry fully. ' +
        'Ideal surface and air temperature is 65–80°F; do not install below 50°F. ' +
        'Remove badges and trim that interfere with placement only if the work order calls for it — otherwise trim around them.',
      include: true,
    },
    {
      id: makeId(),
      title: 'Placement & Install Best Practices',
      body:
        'Dry-fit every panel first: tape the graphic up with masking tape, check it against the dimensions on the proof, and step back to verify it visually matches the proof before removing any liner. ' +
        'Use the hinge method for large panels. Squeegee from center outward with 50% overlapping strokes. ' +
        'Small graphics may carry a 1/4" offset (bubble) cut — align to the printed element, not the material edge. ' +
        'Make relief cuts only where the proof or vehicle curvature requires them, and post-heat all edges, recesses, and relief cuts to 180°F+ so the material stays down. ' +
        'Do not stretch printed graphics to make a dimension work — if a graphic will not land where the proof says without distortion, stop and contact BMG before proceeding.',
      include: true,
    },
    {
      id: makeId(),
      title: 'What We Expect on Every Install',
      body:
        'Placement within tolerance of every dimension in this guide. No visible bubbles, wrinkles, or lifting edges at completion. ' +
        'Photos of each completed side (straight-on, full panel in frame) plus close-ups of any area you had to deviate on, uploaded with your job completion. ' +
        'If anything prevents installing to this guide — damage, badge that will not release, dimension conflict on the actual vehicle — call or message BMG through the job before improvising. ' +
        'Deviations installed without sign-off may need to be redone at the installer’s expense.',
      include: true,
    },
    {
      id: makeId(),
      title: 'Scanning Vehicles with FleetSuite',
      body:
        'DRAFT — finalize before enabling this section. ' +
        'Every vehicle gets scanned in FleetSuite at check-in and completion: open the job, tap Scan, and capture the VIN through the door-jamb barcode (or type the last 8). ' +
        'Attach your completion photos to the scan so the job record shows the finished install. ' +
        'Detailed step-by-step instructions will be added here once the scanning workflow is finalized.',
      include: false,
    },
    {
      id: makeId(),
      title: 'Questions',
      body:
        'Anything unclear on this guide — a dimension that does not match the vehicle, missing material, artwork questions — contact BMG through your job in the installer portal before installing. A five-minute question beats a re-do.',
      include: true,
    },
  ];
}

/**
 * Burn a page's annotations into a canvas at the image's native resolution
 * and return a PNG data URL for the PDF export. `imageSrc` must be
 * CORS-readable (R2 public URL) or the canvas taints and export fails.
 */
export async function renderGuidePage(
  page: GuidePage,
  imageSrc: string,
  units: DimUnits,
  denominator: number,
): Promise<{ dataUrl: string; w: number; h: number } | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous'; // keep the canvas untainted so toDataURL works
  img.src = imageSrc;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);
  drawAnnotations(ctx, page, w, units, denominator);
  return { dataUrl: canvas.toDataURL('image/png'), w, h };
}

/** Shared raster drawing — same geometry the SVG editor renders. */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  page: GuidePage,
  imgW: number,
  units: DimUnits,
  denominator: number,
): void {
  // The editor's SVG strokes are non-scaling (screen px); scale up for the
  // native-resolution raster so lines and text stay legible in the PDF.
  const lineW = Math.max(2, imgW / 600);
  const fontSize = Math.max(14, imgW / 60);
  const arrowLength = fontSize * 0.8;
  const arrowWidth = fontSize * 0.55;
  ctx.font = `700 ${fontSize}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.lineWidth = lineW;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // dy shifts the text within the rotated frame — dims pass -fontSize so the
  // label sits just above its dimension line, drafting-style.
  const labelWithHalo = (text: string, x: number, y: number, angleDeg: number, color: string, dy = 0) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((angleDeg * Math.PI) / 180);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = fontSize / 3.5;
    ctx.strokeText(text, 0, dy);
    ctx.fillStyle = color;
    ctx.fillText(text, 0, dy);
    ctx.restore();
  };

  for (const d of page.dims) {
    if (d.kind === 'note') {
      // Leader arrow from text anchor to target point.
      ctx.strokeStyle = NOTE_COLOR;
      ctx.beginPath();
      ctx.moveTo(d.p2.x, d.p2.y);
      ctx.lineTo(d.p1.x, d.p1.y);
      ctx.stroke();
      const ang = Math.atan2(d.p1.y - d.p2.y, d.p1.x - d.p2.x);
      ctx.fillStyle = NOTE_COLOR;
      ctx.beginPath();
      ctx.moveTo(d.p1.x, d.p1.y);
      ctx.lineTo(d.p1.x - arrowLength * Math.cos(ang - 0.4), d.p1.y - arrowLength * Math.sin(ang - 0.4));
      ctx.lineTo(d.p1.x - arrowLength * Math.cos(ang + 0.4), d.p1.y - arrowLength * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
      const text = d.label || d.note || 'Note';
      const dir = d.p2.x >= d.p1.x ? 1 : -1;
      labelWithHalo(text, d.p2.x + dir * ((ctx.measureText(text).width || 0) / 2 + fontSize / 2), d.p2.y, 0, NOTE_COLOR);
      continue;
    }

    const lay = layoutDimension(d.p1, d.p2, d.offset, {
      gap: lineW * 2,
      overshoot: lineW * 3,
      arrowLength,
      arrowWidth,
    });
    ctx.strokeStyle = DIM_COLOR;
    for (const seg of [lay.extA, lay.extB, lay.dim]) {
      ctx.beginPath();
      ctx.moveTo(seg[0].x, seg[0].y);
      ctx.lineTo(seg[1].x, seg[1].y);
      ctx.stroke();
    }
    ctx.fillStyle = DIM_COLOR;
    for (const tri of [lay.arrowA, lay.arrowB]) {
      ctx.beginPath();
      ctx.moveTo(tri[0].x, tri[0].y);
      ctx.lineTo(tri[1].x, tri[1].y);
      ctx.lineTo(tri[2].x, tri[2].y);
      ctx.closePath();
      ctx.fill();
    }
    const text = dimLabelText(d, page.px_per_in, units, denominator);
    labelWithHalo(text, lay.label.x, lay.label.y, lay.angleDeg, DIM_COLOR, -fontSize * 0.85);
  }
}
