'use client';

/**
 * Invite and login emails link here (deepLinks.authConfirm). The one-time
 * token is checked by THIS page, so the person ends up signed in wherever the
 * link opened: in the phone app when iOS hands it go.bmgfleet.com links, or
 * in the browser on a computer.
 *
 * The old links went to Supabase first, which signed in Safari and only then
 * bounced to go.bmgfleet.com; the app opened on that bounce without a usable
 * session, so new staff were left on a blank screen or the sign-in page.
 * Link scanners that open emails without running scripts can't use up the
 * token either.
 */

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

function safeNextPath(raw: string | null): string {
  if (!raw) return '/home';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/home';
  return raw;
}

export default function AuthConfirmPage() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('bmg-theme') || 'auto';
      document.documentElement.setAttribute('data-theme', saved);
    } catch {}

    const params = new URL(window.location.href).searchParams;
    const tokenHash = params.get('token_hash');
    const type = params.get('type') === 'recovery' ? 'recovery' : 'magiclink';
    const next = safeNextPath(params.get('next'));
    if (!tokenHash) { setFailed(true); return; }

    (async () => {
      const supabase = createClient();
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) {
        // Already used (say, tapped twice) but this device is signed in anyway.
        const { data } = await supabase.auth.getSession();
        if (data?.session) { window.location.replace(next); return; }
        console.warn('Sign-in link failed:', error.message);
        setFailed(true);
        return;
      }
      window.location.replace(next);
    })();
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '20px' }}>
      <div style={{ textAlign: 'center', maxWidth: '340px' }}>
        {failed ? (<>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>This link didn&apos;t work</div>
          <div style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '24px' }}>
            It may have expired or already been used. Sign in with your email and password, or ask a BMG admin to resend your invite.
          </div>
          <button
            onClick={() => window.location.replace('/login')}
            style={{ padding: '12px 24px', borderRadius: '12px', background: 'var(--accent)', color: '#fff', fontSize: '14px', fontWeight: 700, border: 'none', width: '100%' }}
          >
            Go to Sign In
          </button>
        </>) : (
          <div style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 600 }}>Signing you in…</div>
        )}
      </div>
    </div>
  );
}
