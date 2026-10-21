import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Server reads must come from createServiceClient (./supabase-service.ts).
 *
 * A bare createClient with the service key goes through Next's patched
 * fetch, and its PostgREST GETs can be answered from the Data Cache. The
 * estimate PDF did exactly that (Craig, 2026-10-21, EST-2610-066): a line
 * deleted and the rest reordered, the builder showed the save, and Print
 * and Estimate PDF kept rendering the lines from an earlier read.
 *
 * Folders listed here are fully converted; a new route in them that builds
 * its own service client fails this test. Widen the list as more of
 * src/app/api is converted.
 */

const repoRoot = join(__dirname, '..', '..');

const CONVERTED_DIRS = [
  'src/app/api/estimates',
  'src/app/api/approve',
  'src/app/api/quotes/follow-up/email',
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('service-role Supabase clients bypass the fetch cache', () => {
  for (const dir of CONVERTED_DIRS) {
    it(`${dir} builds no service client of its own`, () => {
      const offenders = tsFiles(join(repoRoot, dir))
        .filter(f => readFileSync(f, 'utf8').includes('SUPABASE_SERVICE_ROLE_KEY'))
        .map(f => relative(repoRoot, f));
      expect(offenders).toEqual([]);
    });
  }
});
