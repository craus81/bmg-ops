import type { RoleFeatureSetting } from '@/lib/features';

/**
 * Every saved role setting from More → Admin → Permissions (migration 418).
 * The table holds at most roles × features rows, so callers read it whole.
 * A failed read falls back to the code defaults (logged), which is exactly
 * what every role had before the screen existed.
 */
export async function loadRoleFeatureSettings(service: { from: (t: string) => any }): Promise<RoleFeatureSetting[]> {
  try {
    const { data, error } = await service.from('role_feature_settings').select('role, feature, granted');
    if (error) {
      console.error('role_feature_settings read failed:', error.message);
      return [];
    }
    return (data || []) as RoleFeatureSetting[];
  } catch (e: any) {
    console.error('role_feature_settings read failed:', e?.message || e);
    return [];
  }
}
