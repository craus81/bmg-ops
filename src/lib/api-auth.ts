/**
 * API Route Authentication & Authorization
 *
 * Usage in API routes:
 *   import { requireAuth, requireAdmin } from '@/lib/api-auth';
 *
 *   export async function GET(req: NextRequest) {
 *     const auth = await requireAuth(req);
 *     if (auth.error) return auth.error;
 *     // auth.user is available
 *   }
 *
 *   export async function POST(req: NextRequest) {
 *     const auth = await requireAdmin(req);
 *     if (auth.error) return auth.error;
 *     // auth.user and auth.profile are available
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

interface AuthResult {
  user: any;
  profile?: any;
  error?: NextResponse;
}

/**
 * Verify the request has a valid authenticated session.
 * Returns the user object or an error response.
 */
export async function requireAuth(req: NextRequest): Promise<AuthResult> {
  try {
    // Extract the access token from cookies or Authorization header
    const authHeader = req.headers.get('authorization');
    let accessToken: string | null = null;

    if (authHeader?.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7);
    } else {
      // Try to get from Supabase auth cookies
      const cookies = req.cookies;
      // Supabase stores tokens in cookies with various naming patterns
      for (const [name, cookie] of cookies.getAll().entries()) {
        if (typeof cookie === 'object' && 'name' in cookie && 'value' in cookie) {
          if (cookie.name.includes('auth-token') || cookie.name.includes('access_token') || cookie.name.includes('sb-')) {
            try {
              // Supabase stores a JSON array with [access_token, refresh_token]
              const parsed = JSON.parse(decodeURIComponent(cookie.value));
              if (Array.isArray(parsed) && parsed[0]) {
                accessToken = parsed[0];
                break;
              } else if (parsed.access_token) {
                accessToken = parsed.access_token;
                break;
              }
            } catch {
              // Not JSON, might be the raw token
              if (cookie.value.length > 20 && cookie.name.includes('access')) {
                accessToken = cookie.value;
                break;
              }
            }
          }
        }
      }
    }

    if (!accessToken) {
      return { user: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }

    // Verify the token by getting the user
    const { createClient: createAnonClient } = await import('@supabase/supabase-js');
    const supabase = createAnonClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return { user: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }

    return { user };
  } catch {
    return { user: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
}

/**
 * Verify the request has a valid session AND the user is an admin.
 */
export async function requireAdmin(req: NextRequest): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if (auth.error) return auth;

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, roles, status')
    .eq('id', auth.user.id)
    .single();

  if (!profile || profile.status !== 'approved') {
    return { user: auth.user, error: NextResponse.json({ error: 'Unauthorized' }, { status: 403 }) };
  }

  const roles: string[] = profile.roles?.length > 0 ? profile.roles : [profile.role];
  if (!roles.includes('admin')) {
    return { user: auth.user, profile, error: NextResponse.json({ error: 'Forbidden: admin required' }, { status: 403 }) };
  }

  return { user: auth.user, profile };
}

/**
 * Verify the request has a valid session AND the user has one of the specified roles.
 */
export async function requireRole(req: NextRequest, allowedRoles: string[]): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if (auth.error) return auth;

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, roles, status')
    .eq('id', auth.user.id)
    .single();

  if (!profile || profile.status !== 'approved') {
    return { user: auth.user, error: NextResponse.json({ error: 'Unauthorized' }, { status: 403 }) };
  }

  const roles: string[] = profile.roles?.length > 0 ? profile.roles : [profile.role];
  // Admin always passes
  if (roles.includes('admin')) {
    return { user: auth.user, profile };
  }

  const hasRole = roles.some(r => allowedRoles.includes(r));
  if (!hasRole) {
    return { user: auth.user, profile, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { user: auth.user, profile };
}
