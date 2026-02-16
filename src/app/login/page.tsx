'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'magic' | 'password'>('password');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  // Apply theme on login page too
  useEffect(() => {
    try {
      const saved = localStorage.getItem('bmg-theme') || 'auto';
      document.documentElement.setAttribute('data-theme', saved);
    } catch {}
  }, []);

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true); setError('');
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}/auth/callback` } });
    setLoading(false);
    if (error) setError(error.message); else setSent(true);
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true); setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) setError(error.message); else window.location.href = '/home';
  };

  const labelStyle: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--login-label, rgba(255,255,255,0.45))', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '8px' };
  const inputStyle: React.CSSProperties = { width: '100%', padding: '14px 18px', borderRadius: '12px', border: '1px solid var(--login-input-border, rgba(255,255,255,0.1))', background: 'var(--login-input-bg, rgba(255,255,255,0.06))', color: 'var(--login-text, #fff)', fontSize: '16px', marginBottom: '12px' };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px', background: 'var(--login-bg, linear-gradient(165deg, #152838 0%, #0f1e2a 40%, #0a1520 100%))',
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>
        <div style={{ textAlign: 'center', marginBottom: '36px' }}>
          <img src="/bmg-logo-white.png" alt="BMG Fleet" style={{ height: '72px', marginBottom: '12px' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          <p style={{ fontSize: '13px', color: 'var(--login-text-muted, rgba(255,255,255,0.35))', marginTop: '4px', fontWeight: 500 }}>Fleet Graphics Operations</p>
        </div>

        <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', background: 'var(--login-tab-bg, rgba(255,255,255,0.06))', borderRadius: '10px', padding: '3px' }}>
          {(['password', 'magic'] as const).map((m) => (
            <button key={m} onClick={() => { setMode(m); setError(''); }} style={{
              flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: mode === m ? 'var(--login-tab-active-bg, rgba(255,255,255,0.1))' : 'transparent',
              color: mode === m ? 'var(--login-tab-active-color, #fff)' : 'var(--login-tab-color, rgba(255,255,255,0.4))',
              transition: 'all 0.2s',
            }}>
              {m === 'password' ? 'Password' : 'Magic Link'}
            </button>
          ))}
        </div>

        {sent ? (
          <div style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: '14px', padding: '24px', textAlign: 'center' }}>
            <div style={{ fontSize: '36px', marginBottom: '8px' }}>📧</div>
            <div style={{ fontWeight: 700, fontSize: '16px', color: 'var(--success)' }}>Check your email</div>
            <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)', marginTop: '6px' }}>
              We sent a sign-in link to <strong style={{ color: '#fff' }}>{email}</strong>
            </div>
            <button onClick={() => { setSent(false); setEmail(''); }} style={{ marginTop: '16px', padding: '10px 20px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.5)', fontSize: '13px', fontWeight: 600, background: 'transparent' }}>
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={mode === 'password' ? handlePassword : handleMagicLink}>
            <label style={labelStyle}>Email Address</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@bmgfleet.com" autoFocus autoComplete="email" style={inputStyle} />
            {mode === 'password' && (<>
              <label style={{ ...labelStyle, marginTop: '4px' }}>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" style={inputStyle} />
            </>)}
            {error && (
              <div style={{ padding: '10px 14px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', borderRadius: '10px', color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>
                {error}
              </div>
            )}
            <button type="submit" disabled={!email || (mode === 'password' && !password) || loading} style={{
              width: '100%', padding: '16px', borderRadius: '12px', background: 'var(--orange)',
              color: '#fff', fontSize: '16px', fontWeight: 700,
              opacity: (email && (mode === 'magic' || password) && !loading) ? 1 : 0.5,
              boxShadow: '0 4px 20px rgba(238,49,32,0.3)', transition: 'opacity 0.2s',
            }}>
              {loading ? 'Signing in...' : mode === 'password' ? 'Sign In' : 'Send Magic Link'}
            </button>
            <p style={{ textAlign: 'center', fontSize: '12px', color: 'var(--login-text-muted, rgba(255,255,255,0.25))', marginTop: '16px' }}>
              {mode === 'password' ? 'Contact admin for password reset' : 'No password needed — we\'ll email you a link'}
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
