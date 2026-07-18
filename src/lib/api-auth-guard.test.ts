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
];

// Deliberate exceptions, with the reason they are safe as-is.
const ALLOWLIST = new Set([
  // External installer companies log field scans by design; the route
  // enforces approved-account + non-customer-role checks itself.
  'src/app/api/scans/log/route.ts',
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
