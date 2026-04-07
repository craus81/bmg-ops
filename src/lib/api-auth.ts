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

/**
 * Verify the request has a valid authenticated session.
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
  if (roles.includes('admin')) return { user: auth.user, profile };

  const hasRole = roles.some(r => allowedRoles.includes(r));
  if (!hasRole) {
    return { user: auth.user, profile, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { user: auth.user, profile };
}
