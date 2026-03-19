import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode } from '@/lib/google';
import { createClient } from '@supabase/supabase-js';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(new URL('/admin/pos?google_auth=error&reason=' + error, req.url));
  }

  if (!code) {
    return NextResponse.redirect(new URL('/admin/pos?google_auth=error&reason=no_code', req.url));
  }

  try {
    const tokens = await exchangeCode(code);

    // Store tokens in Supabase using service role
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Upsert - replace any existing token
    await supabase.from('google_tokens').delete().neq('id', '00000000-0000-0000-0000-000000000000'); // clear all

    await supabase.from('google_tokens').insert({
      access_token: tokens.access_token || '',
      refresh_token: tokens.refresh_token || '',
      expiry_date: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      scope: tokens.scope || '',
      token_type: tokens.token_type || 'Bearer',
    });

    return NextResponse.redirect(new URL('/admin/pos?google_auth=success', req.url));
  } catch (err: any) {
    console.error('Google OAuth error:', err);
    return NextResponse.redirect(new URL('/admin/pos?google_auth=error&reason=exchange_failed', req.url));
  }
}
