import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Guard-regression check: routes in these directories touch money (NetSuite
 * invoices/bills, the install ledger's billing stamps, revenue reports) or
 * can message users. A bare requireAuth() admits ANY approved login —
 * including customer and external-installer accounts — so these must use
 * requireStaff / requireAdmin / requireRole.
 */
const SENSITIVE_DIRS = [
  'src/app/api/netsuite',
  'src/app/api/reports',
  'src/app/api/scans',
  'src/app/api/pos',
  'src/app/api/notifications',
  'src/app/api/vendor-invoices',
  'src/app/api/admin',
  // EINs + bank references — requireFeature-gated; a downgrade to bare
  // requireAuth must trip this test. (src/app/api/credit-application,
  // singular, is the public submit endpoint — intentionally unauthenticated,
  // service-role write with rate limit + honeypot, so it is NOT listed.)
  'src/app/api/credit-applications',
  'src/app/api/estimates',
];

// Routes in these directories must be gated on a specific FEATURE, not just
// "is staff": requireStaff admits every internal role, and audit item 9 was
// exactly that — shop/field techs and finance could price, push, email and
// delete any estimate. The value is the guard call every route.ts in the
// directory must contain verbatim.
const FEATURE_GATED_DIRS: Record<string, string> = {
  'src/app/api/estimates': "requireFeature(req, 'estimates')",
};

// Deliberate exceptions, with the reason they are safe as-is.
// (The executive financials routes use requireFinancials — super_admin/
// executive only, which requireRole can't express since it auto-passes any
// admin — so they pass this check without an exemption.)
const ALLOWLIST = new Set([
  // External installer companies log field scans by design; the route
  // enforces approved-account + non-customer-role checks itself.
  'src/app/api/scans/log/route.ts',
  // Completion photos ride the same field-scanner flow (K8) and enforce the
  // same approved-account + non-customer-role checks as scans/log.
  'src/app/api/scans/photos/route.ts',
]);

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

describe('sensitive API routes use staff/admin guards', () => {
  for (const dir of SENSITIVE_DIRS) {
    for (const file of routeFiles(join(repoRoot, dir))) {
      const rel = relative(repoRoot, file).replace(/\\/g, '/');
      if (ALLOWLIST.has(rel)) continue;
      it(rel, () => {
        const src = readFileSync(file, 'utf8');
        expect(
          /\brequireAuth\(/.test(src),
          `${rel} uses bare requireAuth — any approved login (incl. customer/installer) passes. Use requireStaff, requireAdmin, or requireRole, or add to the ALLOWLIST with a reason.`,
        ).toBe(false);
      });
    }
  }
});

describe('feature-gated API routes carry their feature guard', () => {
  for (const [dir, guard] of Object.entries(FEATURE_GATED_DIRS)) {
    const files = routeFiles(join(repoRoot, dir));
    it(`${dir} has routes to check`, () => {
      // An empty directory would make the loop below vacuously green — a
      // rename/move must fail loudly, not silently stop checking.
      expect(files.length).toBeGreaterThan(0);
    });
    for (const file of files) {
      const rel = relative(repoRoot, file).replace(/\\/g, '/');
      it(rel, () => {
        const src = readFileSync(file, 'utf8');
        expect(
          src.includes(guard),
          `${rel} is missing ${guard} — requireStaff admits every internal role (shop/field techs, finance); this directory is feature-gated.`,
        ).toBe(true);
      });
    }
  }
});
