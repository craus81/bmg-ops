import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { systemHealthAudience } from './system-health-audience';
import { makeFakeService } from './quickbooks/test-fake-service';

const svc = () => makeFakeService({
  profiles: [
    { id: 'owner', role: 'admin', roles: ['admin', 'super_admin'], status: 'approved' },
    { id: 'plain-admin', role: 'admin', roles: ['admin'], status: 'approved' },
    { id: 'granted-admin', role: 'admin', roles: ['admin'], status: 'approved' },
    { id: 'pending-owner', role: 'admin', roles: ['admin', 'super_admin'], status: 'pending' },
    { id: 'sales', role: 'sales', roles: ['sales'], status: 'approved' },
  ],
  user_feature_overrides: [
    { user_id: 'granted-admin', feature: 'system_health', granted: true },
    { user_id: 'plain-admin', feature: 'audit_log', granted: true },
    { user_id: 'sales', feature: 'system_health', granted: true },
  ],
});

describe('systemHealthAudience', () => {
  it('is super admins plus anyone individually granted System Health', async () => {
    const ids = await systemHealthAudience(svc() as any);
    expect(ids.sort()).toEqual(['granted-admin', 'owner']);
  });

  it('excludes an admin with no grant — they cannot open the page they would be sent to', async () => {
    expect(await systemHealthAudience(svc() as any)).not.toContain('plain-admin');
  });

  it('excludes an unapproved account even when it holds super_admin', async () => {
    expect(await systemHealthAudience(svc() as any)).not.toContain('pending-owner');
  });

  it('a grant on a NON-admin does not admit them — the base filter is admin', async () => {
    // The `.or('role.eq.admin,roles.cs.{admin}')` runs first, so the override
    // widens the admin set rather than opening the audience to everyone.
    expect(await systemHealthAudience(svc() as any)).not.toContain('sales');
  });

  it('an empty result is a real answer, not an error', async () => {
    const empty = makeFakeService({ profiles: [], user_feature_overrides: [] });
    expect(await systemHealthAudience(empty as any)).toEqual([]);
  });
});

describe('the health check uses this module rather than its own copy', () => {
  it('imports systemHealthAudience and no longer hand-rolls the selection', () => {
    // Two copies is how "the same" audience quietly drifts apart.
    const route = readFileSync(join(process.cwd(), 'src/app/api/cron/health-check/route.ts'), 'utf8');
    expect(route).toContain("from '@/lib/system-health-audience'");
    expect(route).toContain('await systemHealthAudience(service)');
    expect(route).not.toContain("role.eq.admin,roles.cs.{admin}");
  });
});
