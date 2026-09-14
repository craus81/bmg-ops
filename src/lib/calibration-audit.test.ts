import { describe, it, expect } from 'vitest';
import { auditTemplate, summarizeAudits, applyCoverageNorm, median, type AuditInput } from './calibration-audit';

// A well-behaved 1:20 template: 36" x 12" artboard (2592 x 864 pt), previewed
// at 1200 px wide, so 1200 px = 720 real inches -> 1.6667 px/in. A 240"
// vehicle then covers 400 px, a third of the sheet.
const base: AuditInput = {
  id: 't1',
  label: '2024 Ford Transit',
  storedPxPerIn: 1200 / 720,
  overallLengthIn: 240,
  artboard: { widthPt: 2592, heightPt: 864, source: 'eps-bbox' },
  image: { width: 1200, height: 400 },
  scaleFactor: 20,
  recomputedPxPerIn: 1200 / 720,
  letterboxed: false,
};

describe('auditTemplate', () => {
  it('passes a template whose stored scale matches the files', () => {
    const a = auditTemplate(base);
    expect(a.verdict).toBe('ok');
    expect(a.sheetWidthIn).toBeCloseTo(720, 1);
    expect(a.impliedSheetWidthIn).toBeCloseTo(720, 1);
    expect(a.coverage).toBeCloseTo(240 / 720, 3);
    expect(a.drift).toBeCloseTo(1, 3);
  });

  it('reports an uncalibrated template without guessing at it', () => {
    const a = auditTemplate({ ...base, storedPxPerIn: null });
    expect(a.verdict).toBe('uncalibrated');
    expect(a.coverage).toBeNull();
  });

  it('reports unreadable source files separately from bad scale', () => {
    expect(auditTemplate({ ...base, artboard: null }).verdict).toBe('unreadable');
    expect(auditTemplate({ ...base, image: null }).verdict).toBe('unreadable');
  });

  it('calls a vehicle longer than its own sheet impossible', () => {
    // Scale 4x too large: the preview only spans 180 real inches.
    const a = auditTemplate({ ...base, storedPxPerIn: 1200 / 180, recomputedPxPerIn: 1200 / 180 });
    expect(a.verdict).toBe('impossible');
    expect(a.coverage!).toBeGreaterThan(1);
  });

  it('treats a scale a person overrode as hand-calibrated ground truth', () => {
    const a = auditTemplate({ ...base, storedPxPerIn: base.recomputedPxPerIn! * 1.16 });
    expect(a.verdict).toBe('hand-calibrated');
    expect(a.drift).toBeCloseTo(1.16, 3);
  });

  it('ignores drift inside the rounding noise of a recompute', () => {
    expect(auditTemplate({ ...base, storedPxPerIn: base.recomputedPxPerIn! * 1.005 }).verdict).toBe('ok');
  });

  it('flags a letterbox call made against a MediaBox page', () => {
    const a = auditTemplate({
      ...base,
      artboard: { ...base.artboard!, source: 'mediabox' },
      letterboxed: true,
    });
    expect(a.verdict).toBe('suspect-cropped-preview');
  });

  it('leaves a letterbox call against an EPS artwork box alone', () => {
    // An EPS %%BoundingBox already excludes the margin, so padding is the
    // honest reading of an aspect mismatch there.
    expect(auditTemplate({ ...base, letterboxed: true }).verdict).toBe('ok');
  });
});

describe('median', () => {
  it('averages the middle pair on an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
  });
});

describe('summarizeAudits', () => {
  const hand = (id: string, coverage: number) =>
    auditTemplate({
      ...base, id,
      storedPxPerIn: (coverage * 1200) / 240,
      recomputedPxPerIn: (coverage * 1200) / 240 / 1.16,
    });
  const auto = (id: string, coverage: number) =>
    auditTemplate({ ...base, id, storedPxPerIn: (coverage * 1200) / 240, recomputedPxPerIn: (coverage * 1200) / 240 });

  it('reads the scale error off the gap between the two cohorts', () => {
    // Hand-measured templates sit at 40% coverage; auto ones at 34.5% —
    // 16% low, which is 34% too much area.
    const audits = [hand('h1', 0.40), hand('h2', 0.40), auto('a1', 0.345), auto('a2', 0.345)];
    const s = summarizeAudits(audits);
    expect(s.referenceCount).toBe(2);
    expect(s.autoCount).toBe(2);
    expect(s.impliedLinearError!).toBeCloseTo(1.159, 2);
    expect(s.impliedAreaError!).toBeCloseTo(1.344, 2);
  });

  it('withholds a verdict until both cohorts have more than an anecdote', () => {
    const s = summarizeAudits([hand('h1', 0.40), auto('a1', 0.345), auto('a2', 0.345)]);
    expect(s.impliedLinearError).toBeNull();
    expect(s.impliedAreaError).toBeNull();
  });

  it('counts verdicts and artboard sources', () => {
    const s = summarizeAudits([auto('a1', 0.33), auditTemplate({ ...base, id: 'a2', storedPxPerIn: null })]);
    expect(s.byVerdict.ok).toBe(1);
    expect(s.byVerdict.uncalibrated).toBe(1);
    expect(s.byArtboardSource['eps-bbox']).toBe(2);
  });
});

describe('applyCoverageNorm', () => {
  const at = (coverage: number, extra: Partial<AuditInput> = {}) =>
    auditTemplate({
      ...base,
      storedPxPerIn: (coverage * 1200) / 240,
      recomputedPxPerIn: (coverage * 1200) / 240,
      ...extra,
    });

  it('suggests the scale a low-coverage template should have had', () => {
    const [a] = applyCoverageNorm([at(0.345)], 0.40);
    expect(a.verdict).toBe('suspect-scale');
    expect(a.suggestedPxPerIn!).toBeCloseTo((0.40 * 1200) / 240, 3);
    expect(a.note).toMatch(/areas bill 3[45](\.\d)?% high/);
  });

  it('leaves templates inside the tolerance band alone', () => {
    const [a] = applyCoverageNorm([at(0.39)], 0.40);
    expect(a.verdict).toBe('ok');
    expect(a.suggestedPxPerIn).toBeNull();
  });

  it('reports an over-scaled template as billing low', () => {
    const [a] = applyCoverageNorm([at(0.48)], 0.40);
    expect(a.verdict).toBe('suspect-scale');
    expect(a.note).toMatch(/bill .*% low/);
  });

  it('keeps the cropped-preview diagnosis but still suggests a scale', () => {
    const [a] = applyCoverageNorm(
      [at(0.345, { artboard: { widthPt: 2592, heightPt: 864, source: 'mediabox' }, letterboxed: true })],
      0.40,
    );
    expect(a.verdict).toBe('suspect-cropped-preview');
    expect(a.suggestedPxPerIn).not.toBeNull();
  });

  it('is a no-op without a reference norm', () => {
    const audits = [at(0.345)];
    expect(applyCoverageNorm(audits, null)).toEqual(audits);
  });

  it('never rewrites a hand-calibrated or impossible verdict', () => {
    const handCal = auditTemplate({ ...base, storedPxPerIn: base.recomputedPxPerIn! * 1.16 });
    const impossible = auditTemplate({ ...base, storedPxPerIn: 1200 / 180, recomputedPxPerIn: 1200 / 180 });
    const out = applyCoverageNorm([handCal, impossible], 0.40);
    expect(out[0].verdict).toBe('hand-calibrated');
    expect(out[1].verdict).toBe('impossible');
  });
});
