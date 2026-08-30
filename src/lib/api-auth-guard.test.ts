import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { ROUTE_GUARDS } from './route-permissions';

/**
 * The route→permission manifest check (audit Round 2 item 20).
 *
 * Its predecessor spot-checked 7 directories and only asserted "not bare
 * requireAuth" — a route with NO guard at all passed, and 190+ routes were
 * never looked at. Now every route.ts under src/app/api must have an entry
 * in src/lib/route-permissions.ts declaring its guard, the file must
 * actually contain the declared guard markers, stale entries fail, and
 * bare requireAuth( is allowed only where the manifest consciously
 * declares it (requireAuth admits ANY approved login — customer and
 * external-installer accounts included).
 */

const repoRoot = join(__dirname, '..', '..');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

const files = routeFiles(join(repoRoot, 'src/app/api'))
  .map(f => relative(repoRoot, f).replace(/\\/g, '/'))
  .sort();

describe('route→permission manifest', () => {
  it('walks a plausible number of routes', () => {
    // A refactor that breaks the walker would make everything below
    // vacuously green — fail loudly instead.
    expect(files.length).toBeGreaterThan(200);
  });

  it('has no stale entries (deleted or moved routes still declared)', () => {
    const stale = Object.keys(ROUTE_GUARDS).filter(k => !existsSync(join(repoRoot, k)));
    expect(stale, 'remove these from src/lib/route-permissions.ts — their route files no longer exist').toEqual([]);
  });

  it('every entry weaker than a staff wall says why it is safe', () => {
    const missingWhy = Object.entries(ROUTE_GUARDS)
      .filter(([, e]) => ['authScoped', 'token', 'webhook', 'public'].includes(e.kind))
      .filter(([, e]) => (e.why || '').trim().length < 10)
      .map(([k]) => k);
    expect(missingWhy, 'these manifest entries need a real why: sentence').toEqual([]);
  });

  for (const rel of files) {
    it(rel, () => {
      const entry = ROUTE_GUARDS[rel];
      expect(
        entry,
        `${rel} has no entry in src/lib/route-permissions.ts. Every API route declares its guard there — pick the strongest that fits (staff/admin/role/feature/…), or an authScoped/token/webhook/public entry WITH a why. This failing is the point: a forgotten guard becomes a red test, not a production hole.`,
      ).toBeDefined();
      if (!entry) return;

      const src = readFileSync(join(repoRoot, rel), 'utf8');
      for (const needle of entry.contains) {
        expect(
          src.includes(needle),
          `${rel} no longer contains its declared guard marker ${JSON.stringify(needle)} (manifest kind: ${entry.kind}) — restore the guard, or consciously change the manifest entry in the same PR so the downgrade is visible in review.`,
        ).toBe(true);
      }

      // Bare requireAuth( only where the manifest declares it on purpose.
      const callsBareAuth = /\brequireAuth\(/.test(src);
      const declaresBareAuth = entry.contains.includes('requireAuth(');
      expect(
        !callsBareAuth || declaresBareAuth,
        `${rel} calls bare requireAuth( but its manifest entry (${entry.kind}) doesn't declare it. requireAuth admits any approved login — including customer and external-installer accounts. Use requireStaff/requireAdmin/requireRole/requireFeature, or make this an authScoped entry with the in-route check named.`,
      ).toBe(true);
    });
  }
});
