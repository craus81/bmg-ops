import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PDF_RESTLET_MINIMUMS, RESTLET_SPECS, versionAtLeast } from './restlet-versions';

/**
 * The Integration Checkup's RESTlet verdict is only as good as these
 * constants. If someone edits a RESTlet and forgets to bump both sides, the
 * checkup reports a correctly-deployed script as stale (noise nobody acts
 * on) or a stale one as current (the exact lie the feature exists to
 * prevent). This test is what makes forgetting impossible.
 */
describe('RESTlet versions', () => {
  const repoRoot = join(__dirname, '..', '..');

  for (const spec of RESTLET_SPECS) {
    it(`${spec.label}: script SCRIPT_VERSION matches the expected version`, () => {
      const source = readFileSync(join(repoRoot, spec.scriptFile), 'utf8');
      const match = source.match(/var SCRIPT_VERSION = '([^']+)'/);
      expect(match, `${spec.scriptFile} has no SCRIPT_VERSION constant`).toBeTruthy();
      expect(match![1]).toBe(spec.expectedVersion);
    });

    it(`${spec.label}: script answers action=ping`, () => {
      const source = readFileSync(join(repoRoot, spec.scriptFile), 'utf8');
      expect(source).toContain("action === 'ping'");
      expect(source).toContain('version: SCRIPT_VERSION');
    });
  }

  it('every spec names an env var the checkup can read', () => {
    for (const spec of RESTLET_SPECS) {
      expect(spec.envVar).toMatch(/^NETSUITE_[A-Z_]+_RESTLET_URL$/);
    }
  });

  it("compares versions by day, then by the number after it", () => {
    expect(versionAtLeast('2026-11-01.1', '2026-11-01.1')).toBe(true);
    expect(versionAtLeast('2026-11-01.2', '2026-11-01.1')).toBe(true);
    expect(versionAtLeast('2026-11-01.10', '2026-11-01.9')).toBe(true);
    expect(versionAtLeast('2026-11-01.9', '2026-11-01.10')).toBe(false);
    expect(versionAtLeast('2026-11-02.1', '2026-11-01.5')).toBe(true);
    expect(versionAtLeast('2026-10-31.9', '2026-11-01.1')).toBe(false);
    expect(versionAtLeast('2027-01-01.1', '2026-12-31.1')).toBe(true);
    expect(versionAtLeast(null, '2026-11-01.1')).toBe(false);
    expect(versionAtLeast(undefined, '2026-11-01.1')).toBe(false);
    expect(versionAtLeast('', '2026-11-01.1')).toBe(false);
    expect(versionAtLeast('2026-11-01', '2026-11-01.1')).toBe(false);
    expect(versionAtLeast('v2026-11-01.1', '2026-11-01.1')).toBe(false);
    expect(versionAtLeast('2026-11-01.1 ', '2026-11-01.1')).toBe(false);
    expect(versionAtLeast('2026-11-01.1', 'newest')).toBe(false);
  });

  it("gates each of the PDF script's later powers on its own minimum, which the script in the repo meets", () => {
    const pdf = RESTLET_SPECS.find((s) => s.key === 'pdf')!;
    expect(PDF_RESTLET_MINIMUMS).toEqual({ creditMemos: '2026-09-15.1', attachPdf: '2026-11-01.1' });
    for (const minimum of Object.values(PDF_RESTLET_MINIMUMS)) expect(versionAtLeast(pdf.expectedVersion, minimum)).toBe(true);
    // A deployment from before attaching came in still renders credit memos.
    expect(versionAtLeast('2026-09-15.1', PDF_RESTLET_MINIMUMS.creditMemos)).toBe(true);
    expect(versionAtLeast('2026-09-15.1', PDF_RESTLET_MINIMUMS.attachPdf)).toBe(false);
  });
});
