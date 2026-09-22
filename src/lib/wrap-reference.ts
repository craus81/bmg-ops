/**
 * The wrap dimension sheet as a calibration yardstick.
 *
 * `vehicle_templates.panel_data` holds what the manufacturer's wrap
 * dimension sheet says each panel actually measures — extracted from the
 * PDF in the knowledge base by scripts/extract-dimensions.mjs, alongside
 * the vehicle's overall length, height, and wheelbase. Until now only the
 * AI chat read it; the estimator calibrated against whatever number a
 * person typed after dragging a line, which is a measurement of a picture
 * rather than of a vehicle.
 *
 * Calibrating against the sheet removes that guess: trace a feature whose
 * real length is already published and the scale follows from it. Longer
 * references are better — a few pixels of sloppy tracing is a much smaller
 * fraction of a 222" side than of a 40" hood — so these come back longest
 * first.
 */

export interface PanelDimension {
  name: string;
  label?: string | null;
  width_in?: number | null;
  height_in?: number | null;
  area_sqft?: number | null;
}

export interface ReferenceSource {
  overall_length_in?: number | null;
  overall_height_in?: number | null;
  wheelbase_in?: number | null;
  panel_data?: PanelDimension[] | null;
}

export interface ReferenceDimension {
  /** Stable per-template id, so React keys don't shuffle. */
  key: string;
  /** What to trace, e.g. "Driver Side — width". */
  label: string;
  inches: number;
  kind: 'overall' | 'panel';
}

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return isFinite(x) && x > 0 ? x : 0;
};

/**
 * Every published dimension on this template that a person could trace a
 * line along, longest first. Values within a tenth of an inch of one
 * already listed are dropped — a van's two identical sides are one
 * yardstick, not two, and a short list is one somebody will actually read.
 */
export function referenceDimensions(t: ReferenceSource | null | undefined): ReferenceDimension[] {
  if (!t) return [];
  const out: ReferenceDimension[] = [];

  const push = (key: string, label: string, inches: number, kind: ReferenceDimension['kind']) => {
    if (inches <= 0) return;
    out.push({ key, label, inches, kind });
  };

  push('overall-length', 'Overall length', n(t.overall_length_in), 'overall');
  push('overall-height', 'Overall height', n(t.overall_height_in), 'overall');
  push('wheelbase', 'Wheelbase', n(t.wheelbase_in), 'overall');

  (t.panel_data || []).forEach((p, i) => {
    const name = (p?.name || p?.label || `Panel ${i + 1}`).trim();
    push(`panel-${i}-w`, `${name} — width`, n(p?.width_in), 'panel');
    push(`panel-${i}-h`, `${name} — height`, n(p?.height_in), 'panel');
  });

  out.sort((a, b) => b.inches - a.inches);

  const seen: number[] = [];
  return out.filter(r => {
    if (seen.some(v => Math.abs(v - r.inches) < 0.1)) return false;
    seen.push(r.inches);
    return true;
  });
}

export interface CalibrationDelta {
  /** The scale this traced line and reference imply. */
  pxPerIn: number;
  /** How a panel's measured length changes if this is saved. */
  linearRatio: number | null;
  /** And, because quotes bill area, the square of that. */
  areaRatio: number | null;
}

/**
 * What saving this calibration would do to the numbers. Shown before the
 * save, not after: a scale change silently rewrites every panel on every
 * future quote for this vehicle, and the person clicking Save is the only
 * one who will ever see it happen.
 */
export function calibrationDelta(
  lenPx: number,
  inches: number,
  storedPxPerIn: number | null | undefined,
): CalibrationDelta | null {
  if (!(lenPx > 0) || !(inches > 0)) return null;
  const pxPerIn = lenPx / inches;
  const stored = n(storedPxPerIn);
  if (!stored) return { pxPerIn, linearRatio: null, areaRatio: null };
  const linearRatio = stored / pxPerIn;
  return { pxPerIn, linearRatio, areaRatio: linearRatio * linearRatio };
}
