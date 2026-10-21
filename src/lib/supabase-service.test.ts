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
 * Every server file is converted; one that builds its own service client
 * (createClient with the service key, or a variable holding it) fails.
 */

const repoRoot = join(__dirname, '..', '..');

// createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY...) or
// createClient(url, someServiceKeyVariable).
const OWN_SERVICE_CLIENT = /createClient\(\s*[^,()]+,\s*(process\.env\.SUPABASE_SERVICE_ROLE_KEY|\w*[sS]ervice\w*[kK]ey\w*|key)\b/;

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
  it('no file under src builds a service client of its own', () => {
    const offenders = tsFiles(join(repoRoot, 'src'))
      .filter(f => !f.endsWith('supabase-service.ts'))
      .filter(f => OWN_SERVICE_CLIENT.test(readFileSync(f, 'utf8')))
      .map(f => relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });
});
