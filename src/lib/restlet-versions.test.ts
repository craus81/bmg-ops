import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RESTLET_SPECS } from './restlet-versions';

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
});
