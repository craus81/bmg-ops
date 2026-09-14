/**
 * Read-only audit of wrap-template scale calibration.
 *
 * Why this exists: every panel drawn in the wrap estimator is measured in
 * template-image pixels and divided by the template's `px_per_in`, so a
 * scale that is too small makes every dimension too long — and since the
 * quote bills AREA, the error is squared. A 16% scale error reads as ~35%
 * more square footage, on every panel, on every quote built from that
 * template, with nothing visibly wrong on screen.
 *
 * Auto-calibration (`computeCalibration`) derives the scale from the vector
 * artboard and the preview's pixel size. It has one blind spot it cannot
 * resolve from those two numbers alone: when the preview's aspect ratio
 * doesn't match the artboard's, it assumes the renderer LETTERBOXED the
 * artwork (padded one axis) and takes the smaller axis ratio. A preview
 * that was instead CROPPED to the artwork produces the very same aspect
 * mismatch, and the same branch then divides the preview's pixels by a
 * real-world width that includes margin the pixels don't cover — a
 * px_per_in that is too small. That is the population this audit is built
 * to find, so it reports which box each artboard came from: per the EPS
 * spec a %%BoundingBox already excludes the margin (it bounds the marks),
 * while a PDF/AI /MediaBox is the whole page, so MediaBox templates are the
 * ones exposed to this.
 *
 * Nothing here writes. It reports evidence and lets a human decide.
 */

import type { ArtboardSource, ArtboardSize, PixelSize } from './template-calibration';

export type AuditVerdict =
  /** No stored scale — the estimator refuses to draw on these anyway. */
  | 'uncalibrated'
  /** Neither the vector nor the preview could be read; nothing to say. */
  | 'unreadable'
  /** The vehicle would have to span more pixels than the preview has. */
  | 'impossible'
  /** MediaBox artboard + aspect mismatch: the cropped-vs-letterboxed trap. */
  | 'suspect-cropped-preview'
  /** Vehicle occupies far less of the sheet than the hand-calibrated norm. */
  | 'suspect-scale'
  /** Stored scale no longer matches what the files recompute to. */
  | 'hand-calibrated'
  | 'ok';

export interface AuditInput {
  id: string;
  label: string;
  /** The scale the estimator actually measures with today. */
  storedPxPerIn: number | null;
  /** Real-world vehicle length, when the template records one. */
  overallLengthIn: number | null;
  /** Artboard read from the vector file, with the box it came from. */
  artboard: (ArtboardSize & { source: ArtboardSource }) | null;
  image: PixelSize | null;
  /** 20 for a 1:20 drawing. */
  scaleFactor: number;
  /** What `computeCalibration` produces from the same files, today. */
  recomputedPxPerIn: number | null;
  /** True when computeCalibration took its letterbox branch. */
  letterboxed: boolean;
}

export interface TemplateAudit {
  id: string;
  label: string;
  verdict: AuditVerdict;
  storedPxPerIn: number | null;
  recomputedPxPerIn: number | null;
  artboardSource: ArtboardSource | null;
  letterboxed: boolean;
  /** How far the stored scale has moved from the recomputed one, as a ratio. */
  drift: number | null;
  /** Real-world width the artboard covers at this scale, in inches. */
  sheetWidthIn: number | null;
  /** Real-world width the PREVIEW covers at the stored scale, in inches. */
  impliedSheetWidthIn: number | null;
  /** Fraction of the preview's width the vehicle occupies at this scale. */
  coverage: number | null;
  /** Set only where a reference cohort makes a correction defensible. */
  suggestedPxPerIn: number | null;
  note: string;
}

const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Middle value, averaging the pair on an even count. Empty → null. */
export function median(values: number[]): number | null {
  const xs = values.filter(v => isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * A stored scale more than this far from the recomputed one means a person
 * overrode it in the estimator — those are the hand-measured templates, and
 * the only ground truth the library has about its own scale.
 */
const HAND_CALIBRATION_DRIFT = 0.01;

/**
 * How far below the hand-calibrated norm a template's coverage may sit
 * before it is called out. Vehicles genuinely vary in how much of their
 * sheet they fill, so this stays loose enough not to cry wolf over a short
 * wheelbase on a wide artboard.
 */
const COVERAGE_TOLERANCE = 0.08;

/** One template's evidence, before any cross-library comparison. */
export function auditTemplate(input: AuditInput): TemplateAudit {
  const { id, label, storedPxPerIn, overallLengthIn, artboard, image, scaleFactor } = input;
  const base = {
    id,
    label,
    storedPxPerIn,
    recomputedPxPerIn: input.recomputedPxPerIn,
    artboardSource: artboard?.source ?? null,
    letterboxed: input.letterboxed,
    drift: null as number | null,
    sheetWidthIn: null as number | null,
    impliedSheetWidthIn: null as number | null,
    coverage: null as number | null,
    suggestedPxPerIn: null as number | null,
  };

  if (!storedPxPerIn || storedPxPerIn <= 0) {
    return { ...base, verdict: 'uncalibrated', note: 'No scale stored — panels can’t be drawn until this is calibrated.' };
  }
  if (!artboard || !image) {
    return {
      ...base,
      verdict: 'unreadable',
      note: !artboard
        ? 'Vector artboard unreadable, so the stored scale can’t be checked against the source files.'
        : 'Preview image unreadable, so the stored scale can’t be checked against the source files.',
    };
  }

  const sheetWidthIn = (artboard.widthPt / 72) * scaleFactor;
  const impliedSheetWidthIn = image.width / storedPxPerIn;
  const coverage = overallLengthIn && overallLengthIn > 0 ? (storedPxPerIn * overallLengthIn) / image.width : null;
  const drift = input.recomputedPxPerIn && input.recomputedPxPerIn > 0
    ? storedPxPerIn / input.recomputedPxPerIn
    : null;

  const measured = {
    ...base,
    drift: drift == null ? null : round(drift, 4),
    sheetWidthIn: round(sheetWidthIn, 1),
    impliedSheetWidthIn: round(impliedSheetWidthIn, 1),
    coverage: coverage == null ? null : round(coverage, 4),
  };

  // Hard contradiction: the vehicle cannot be longer than the sheet it is
  // drawn on. This one needs no norm to call — it is arithmetic.
  if (coverage != null && coverage > 1) {
    return {
      ...measured,
      verdict: 'impossible',
      note: `At this scale the preview only spans ${round(impliedSheetWidthIn, 0)}" but the vehicle is ${overallLengthIn}" long — the scale is too large, so panels measure short.`,
    };
  }

  if (drift != null && Math.abs(drift - 1) > HAND_CALIBRATION_DRIFT) {
    return {
      ...measured,
      verdict: 'hand-calibrated',
      note: `Someone set this scale by hand — it sits ${round((drift - 1) * 100, 1)}% off what the files recompute to. Treated as ground truth.`,
    };
  }

  // The trap: a MediaBox is the page, margins included, so pixels that
  // cover only the artwork get divided by too much real width.
  if (input.letterboxed && (artboard.source === 'mediabox' || artboard.source === 'mediabox-compressed')) {
    return {
      ...measured,
      verdict: 'suspect-cropped-preview',
      note: 'Preview aspect doesn’t match the /MediaBox page and was assumed to be padding. If the preview is cropped to the artwork instead, this scale is too small and every panel measures long.',
    };
  }

  return { ...measured, verdict: 'ok', note: 'Stored scale matches what the source files recompute to.' };
}

export interface AuditSummary {
  total: number;
  byVerdict: Record<AuditVerdict, number>;
  byArtboardSource: Record<string, number>;
  /** Coverage norm from the hand-calibrated templates, when there are any. */
  referenceCoverage: number | null;
  referenceCount: number;
  /** Coverage norm from the auto-calibrated templates. */
  autoCoverage: number | null;
  autoCount: number;
  /**
   * How much longer an auto-calibrated panel measures than a hand-measured
   * one, and — because quotes bill area — the square of that. Null until
   * both cohorts have enough templates with a known vehicle length to
   * compare.
   */
  impliedLinearError: number | null;
  impliedAreaError: number | null;
}

/**
 * The library-wide picture. The shop's own hand-calibrated templates are
 * the reference: whatever fraction of the sheet a vehicle covers on those
 * is what it should cover everywhere, so the gap between the two cohorts is
 * the scale error — and its square is how much square footage every quote
 * built on an auto-calibrated template is overstating.
 */
export function summarizeAudits(audits: TemplateAudit[]): AuditSummary {
  const byVerdict = {
    uncalibrated: 0, unreadable: 0, impossible: 0,
    'suspect-cropped-preview': 0, 'suspect-scale': 0, 'hand-calibrated': 0, ok: 0,
  } as Record<AuditVerdict, number>;
  const byArtboardSource: Record<string, number> = {};
  for (const a of audits) {
    byVerdict[a.verdict]++;
    const src = a.artboardSource || 'unreadable';
    byArtboardSource[src] = (byArtboardSource[src] || 0) + 1;
  }

  const withCoverage = audits.filter(a => a.coverage != null && a.coverage > 0);
  const reference = withCoverage.filter(a => a.verdict === 'hand-calibrated');
  const auto = withCoverage.filter(a => a.verdict !== 'hand-calibrated');
  const referenceCoverage = median(reference.map(a => a.coverage!));
  const autoCoverage = median(auto.map(a => a.coverage!));

  // Two of each side, minimum — one template is an anecdote, not a norm.
  const comparable = reference.length >= 2 && auto.length >= 2 && referenceCoverage && autoCoverage;
  const linear = comparable ? referenceCoverage! / autoCoverage! : null;

  return {
    total: audits.length,
    byVerdict,
    byArtboardSource,
    referenceCoverage: referenceCoverage == null ? null : round(referenceCoverage, 4),
    referenceCount: reference.length,
    autoCoverage: autoCoverage == null ? null : round(autoCoverage, 4),
    autoCount: auto.length,
    impliedLinearError: linear == null ? null : round(linear, 4),
    impliedAreaError: linear == null ? null : round(linear * linear, 4),
  };
}

/**
 * Second pass: with a reference norm in hand, flag the auto-calibrated
 * templates that sit outside it and say what their scale should have been.
 * Verdicts that already stand on their own arithmetic are left alone.
 */
export function applyCoverageNorm(audits: TemplateAudit[], referenceCoverage: number | null): TemplateAudit[] {
  if (!referenceCoverage || referenceCoverage <= 0) return audits;
  return audits.map(a => {
    if (a.coverage == null || a.verdict === 'hand-calibrated' || a.verdict === 'uncalibrated' ||
        a.verdict === 'unreadable' || a.verdict === 'impossible') return a;
    const ratio = a.coverage / referenceCoverage;
    if (Math.abs(ratio - 1) <= COVERAGE_TOLERANCE) return a;
    const suggested = a.storedPxPerIn! / ratio;
    const areaError = 1 / (ratio * ratio);
    return {
      ...a,
      verdict: a.verdict === 'suspect-cropped-preview' ? a.verdict : 'suspect-scale',
      suggestedPxPerIn: round(suggested, 4),
      note: ratio < 1
        ? `Vehicle covers ${round(a.coverage * 100, 1)}% of the preview against a hand-measured norm of ${round(referenceCoverage * 100, 1)}% — panels measure ${round((1 / ratio - 1) * 100, 1)}% long, so areas bill ${round((areaError - 1) * 100, 1)}% high.`
        : `Vehicle covers ${round(a.coverage * 100, 1)}% of the preview against a hand-measured norm of ${round(referenceCoverage * 100, 1)}% — panels measure ${round((1 - 1 / ratio) * 100, 1)}% short, so areas bill ${round((1 - areaError) * 100, 1)}% low.`,
    };
  });
}
