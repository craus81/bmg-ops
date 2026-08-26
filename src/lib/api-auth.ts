/**
 * API Route Authentication & Authorization
 *
 * Verifies Supabase auth sessions from cookies or Authorization headers.
 * The Supabase JS client stores sessions in cookies named like:
 *   sb-<project-ref>-auth-token
 * The value is a base64-encoded JSON with access_token and refresh_token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveFeatures, type FeatureKey } from '@/lib/features';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

interface AuthResult {
  user: any;
  profile?: any;
  error?: NextResponse;
}

function extractAccessToken(req: NextRequest): string | null {
  // 1. Check Authorization header
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Check Supabase auth cookies
  const cookies = req.cookies.getAll();
  for (const cookie of cookies) {
    // Match our custom cookie name and standard Supabase patterns
    if (cookie.name === 'sb-auth-token' || (cookie.name.includes('sb-') && cookie.name.includes('auth-token'))) {
      try {
        const decoded = decodeURIComponent(cookie.value);
        // Try parsing as JSON (newer Supabase versions)
        const parsed = JSON.parse(decoded);
        if (parsed.access_token) return parsed.access_token;
        if (Array.isArray(parsed) && parsed[0]) return parsed[0];
      } catch {
        // May be base64 encoded
        try {
          const decoded2 = atob(cookie.value);
          const parsed2 = JSON.parse(decoded2);
          if (parsed2.access_token) return parsed2.access_token;
        } catch {
          // Raw token value
          if (cookie.value.length > 20) return cookie.value;
        }
      }
    }
  }

  // 3. Check for chunked cookies (sb-<ref>-auth-token.0, .1, etc.)
  const chunks: { index: number; value: string }[] = [];
  for (const cookie of cookies) {
    const match = cookie.name.match(/sb-.*-auth-token\.(\d+)/);
    if (match) {
      chunks.push({ index: parseInt(match[1]), value: cookie.value });
    }
  }
  if (chunks.length > 0) {
    chunks.sort((a, b) => a.index - b.index);
    const combined = chunks.map(c => c.value).join('');
    try {
      const decoded = decodeURIComponent(combined);
      const parsed = JSON.parse(decoded);
      if (parsed.access_token) return parsed.access_token;
    } catch {
      try {
        const decoded2 = atob(combined);
        const parsed2 = JSON.parse(decoded2);
        if (parsed2.access_token) return parsed2.access_token;
      } catch {}
    }
  }

  return null;
}

// Roles that belong to internal BMG staff. Excludes 'customer' accounts and
// external CNI 'installer' accounts, which must never see company-wide data.
const INTERNAL_STAFF_ROLES = ['admin', 'sales', 'graphics_production', 'shop_tech', 'field_tech', 'finance'];

function profileRoles(profile: any): string[] {
  return profile?.roles?.length > 0 ? profile.roles : [profile?.role];
}

/**
 * Public accessor for a profile's effective roles (roles[] with a fallback to
 * the scalar role), so route handlers can make role decisions on the caller
 * without re-implementing the array/scalar rule.
 */
export function getProfileRoles(profile: any): string[] {
  return profileRoles(profile);
}

/**
 * Is this profile internal BMG staff (same set requireStaff gates on)? For
 * routes that must allow EITHER staff OR another authorized principal (e.g. a
 * CNI job message can be sent by a coordinator OR the job's installer), where
 * requireStaff alone would wrongly reject the non-staff side.
 */
export function isInternalStaffRole(profile: any): boolean {
  return profileRoles(profile).some(r => INTERNAL_STAFF_ROLES.includes(r));
}

/**
 * Verify the request has a valid authenticated session AND the account has
 * been approved by an admin. Pending, denied, and deactivated accounts are
 * rejected. Returns the user's profile so downstream checks can reuse it.
 */
export async function requireAuth(req: NextRequest): Promise<AuthResult> {
  try {
    const accessToken = extractAccessToken(req);

    if (!accessToken) {
      return { user: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }

    // Verify the token
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return { user: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }

    const service = createClient(supabaseUrl, supabaseServiceKey);
    const { data: profile } = await service
      .from('profiles')
      .select('id, role, roles, status, deactivated')
      .eq('id', user.id)
      .single();

    // Reject pending/denied accounts AND soft-deleted (deactivated) ones. The
    // Users page tells admins a deactivated account "will no longer be able to
    // log in", but nothing enforced that — a deactivated user with a live
    // session (or who simply logs back in) kept full role access until now.
    if (!profile || profile.status !== 'approved' || profile.deactivated === true) {
      return { user, profile, error: NextResponse.json({ error: 'Forbidden: account not approved' }, { status: 403 }) };
    }

    return { user, profile };
  } catch {
    return { user: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
}

/**
 * Verify the request has a valid session AND the user is internal BMG staff.
 * Use for routes that expose company-wide data (estimates, prospects,
 * contacts, reports) which customer and external installer accounts must
 * not access.
 */
export async function requireStaff(req: NextRequest): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if (auth.error) return auth;

  const roles = profileRoles(auth.profile);
  if (!roles.some(r => INTERNAL_STAFF_ROLES.includes(r))) {
    return { user: auth.user, profile: auth.profile, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return auth;
}

/**
 * Verify the request has a valid session AND the user is an admin.
 */
export async function requireAdmin(req: NextRequest): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if (auth.error) return auth;

  const roles = profileRoles(auth.profile);
  if (!roles.includes('admin')) {
    return { user: auth.user, profile: auth.profile, error: NextResponse.json({ error: 'Forbidden: admin required' }, { status: 403 }) };
  }

  return auth;
}

/**
 * Verify the request has a valid session AND the user can see company
 * financials: super_admin or executive ONLY (not regular admin/staff),
 * matching the `financials` feature in src/lib/features.ts. `executive` is a
 * standalone role outside INTERNAL_STAFF_ROLES, so requireStaff can't gate
 * these routes.
 */
export async function requireFinancials(req: NextRequest): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if (auth.error) return auth;

  const roles = profileRoles(auth.profile);
  if (!(roles.includes('super_admin') || roles.includes('executive'))) {
    return { user: auth.user, profile: auth.profile, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return auth;
}

/**
 * Verify the request has a valid session AND the user is a super_admin.
 *
 * Unlike requireRole(req, ['super_admin']), this does NOT auto-pass regular
 * admins — requireRole short-circuits on any admin before checking the allowed
 * list, which silently defeats a super-admin-only gate. Use this for the
 * owner-level wall (editing other users' settings, granting super_admin).
 */
export async function requireSuperAdmin(req: NextRequest): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if (auth.error) return auth;

  const roles = profileRoles(auth.profile);
  if (!roles.includes('super_admin')) {
    return { user: auth.user, profile: auth.profile, error: NextResponse.json({ error: 'Forbidden: super admin required' }, { status: 403 }) };
  }

  return auth;
}

/**
 * Verify the request has a valid session AND the caller's EFFECTIVE features
 * (role defaults + per-user overrides) include `key`. This is the server-side
 * twin of the client `useRequireFeature`/`hasFeature`: it runs the SAME
 * `resolveFeatures` over the caller's roles + their `user_feature_overrides`
 * rows, so a per-user grant or revoke is finally enforced on the backend (until
 * now overrides were resolved client-side only — pure UI theater).
 */
export async function requireFeature(req: NextRequest, key: FeatureKey): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if (auth.error) return auth;

  const service = createClient(supabaseUrl, supabaseServiceKey);
  const { data: overrides } = await service
    .from('user_feature_overrides')
    .select('feature, granted')
    .eq('user_id', auth.user.id);

  // Normalize the legacy 'production' role to 'graphics_production' so the
  // server resolves the same feature set the client does (AuthProvider does
  // this normalization); without it a 'production'-role account would resolve
  // to zero features here while the UI shows it the graphics set.
  const roles = profileRoles(auth.profile).map(r => (r === 'production' ? 'graphics_production' : r));
  const features = resolveFeatures(roles, overrides || []);
  if (!features.has(key)) {
    return { user: auth.user, profile: auth.profile, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return auth;
}

/**
 * Verify the request has a valid session AND the user has one of the specified roles.
 */
export async function requireRole(req: NextRequest, allowedRoles: string[]): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if (auth.error) return auth;

  const roles = profileRoles(auth.profile);
  if (roles.includes('admin')) return auth;

  const hasRole = roles.some(r => allowedRoles.includes(r));
  if (!hasRole) {
    return { user: auth.user, profile: auth.profile, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return auth;
}
