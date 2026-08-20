'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // null = still waiting for the recovery link's session to land
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const supabase = createClient();

  useEffect(() => {
    try {
      const saved = localStorage.getItem('bmg-theme') || 'auto';
      document.documentElement.setAttribute('data-theme', saved);
    } catch {}
  }, []);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }: any) => {
      if (active && data.session) setHasSession(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event: string, session: any) => {
      if (active && session) setHasSession(true);
    });

    // The session arrives from the URL hash shortly after load; if it never
    // does, the link was invalid or expired.
    const timer = setTimeout(() => {
      if (active) setHasSession((prev) => (prev === null ? false : prev));
    }, 4000);

    return () => {
      active = false;
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: run once on mount
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setLoading(true); setError('');
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) { setError(error.message); return; }
    setDone(true);
    setTimeout(() => { window.location.href = '/home'; }, 2000);
  };

  const labelStyle: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--login-label, rgba(255,255,255,0.45))', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '8px' };
  const inputStyle: React.CSSProperties = { width: '100%', padding: '14px 18px', borderRadius: '12px', border: '1px solid var(--login-input-border, rgba(255,255,255,0.1))', background: 'var(--login-input-bg, rgba(255,255,255,0.06))', color: 'var(--login-text, #fff)', fontSize: '16px', marginBottom: '12px' };

  return (
    <div style={{
      minHeight: 'calc(100vh / var(--ts))', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px', background: 'var(--login-bg, linear-gradient(165deg, #152838 0%, #0f1e2a 40%, #0a1520 100%))',
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>
        <div style={{ textAlign: 'center', marginBottom: '36px' }}>
          <img src="/bmg-logo-white.png" alt="BMG Fleet" style={{ height: '72px', marginBottom: '12px' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          <p style={{ fontSize: '15px', color: 'var(--login-text-muted, rgba(255,255,255,0.5))', marginTop: '4px', fontWeight: 700, letterSpacing: '0.5px' }}>FleetSuite</p>
        </div>

        {done ? (
          <div style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: '14px', padding: '24px', textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: '16px', color: 'var(--success)' }}>Password Updated</div>
            <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', marginTop: '6px' }}>
              You&apos;re signed in. Taking you to the app...
            </div>
          </div>
        ) : hasSession === null ? (
          <div style={{ textAlign: 'center', color: 'var(--login-text-muted, rgba(255,255,255,0.5))', fontSize: '14px' }}>
            Verifying reset link...
          </div>
        ) : hasSession === false ? (
          <div style={{ background: 'var(--error-bg, rgba(239,68,68,0.08))', border: '1px solid var(--error-border, rgba(239,68,68,0.2))', borderRadius: '14px', padding: '24px', textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: '16px', color: 'var(--error, #ef4444)' }}>Link Invalid or Expired</div>
            <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', marginTop: '6px', lineHeight: '1.6' }}>
              This password reset link is no longer valid. Request a new one from the sign-in page.
            </div>
            <a href="/login" style={{ display: 'inline-block', marginTop: '16px', padding: '10px 20px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.75)', fontSize: '13px', fontWeight: 600, textDecoration: 'none' }}>
              Back to Sign In
            </a>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <p style={{ fontSize: '13px', color: 'var(--login-text-muted, rgba(255,255,255,0.5))', marginBottom: '16px', lineHeight: '1.5' }}>
              Choose a new password for your account.
            </p>

            <label style={labelStyle}>New Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" autoFocus autoComplete="new-password" style={inputStyle} />

            <label style={{ ...labelStyle, marginTop: '4px' }}>Confirm New Password</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter your new password" autoComplete="new-password" style={inputStyle} />

            {error && (
              <div style={{ padding: '10px 14px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', borderRadius: '10px', color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={!password || !confirm || loading} style={{
              width: '100%', padding: '16px', borderRadius: '12px', background: 'var(--orange)',
              color: '#fff', fontSize: '16px', fontWeight: 700,
              opacity: (password && confirm && !loading) ? 1 : 0.5,
              boxShadow: '0 4px 20px rgba(238,49,32,0.3)', transition: 'opacity 0.2s',
            }}>
              {loading ? 'Updating...' : 'Set New Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
