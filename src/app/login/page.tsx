'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'magic' | 'password'>('password');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setError('');

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setError('');

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      window.location.href = '/home';
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', background: '#0f1720' }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            width: '56px', height: '56px', borderRadius: '14px',
            background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: '16px', color: '#fff',
            margin: '0 auto 12px',
          }}>BMG</div>
          <h1 style={{ fontSize: '22px', fontWeight: 800, color: '#e8ecf1' }}>BMG Ops</h1>
          <p style={{ fontSize: '13px', color: '#4a5f78', marginTop: '4px' }}>Fleet Graphics Operations</p>
        </div>

        <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', background: '#141e2b', borderRadius: '8px', padding: '3px' }}>
          <button
            onClick={() => { setMode('password'); setError(''); }}
            style={{
              flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
              background: mode === 'password' ? 'rgba(59,130,246,0.15)' : 'transparent',
              border: 'none', color: mode === 'password' ? '#60a5fa' : '#4a5f78',
            }}
          >
            Password
          </button>
          <button
            onClick={() => { setMode('magic'); setError(''); }}
            style={{
              flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
              background: mode === 'magic' ? 'rgba(59,130,246,0.15)' : 'transparent',
              border: 'none', color: mode === 'magic' ? '#60a5fa' : '#4a5f78',
            }}
          >
            Magic Link
          </button>
        </div>

        {sent ? (
          <div style={{
            background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)',
            borderRadius: '12px', padding: '20px', textAlign: 'center',
          }}>
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>📧</div>
            <div style={{ fontWeight: 700, fontSize: '15px', color: '#4ade80' }}>Check your email</div>
            <div style={{ fontSize: '13px', color: '#6b7a8d', marginTop: '6px' }}>
              We sent a sign-in link to <strong style={{ color: '#e8ecf1' }}>{email}</strong>
            </div>
            <div style={{ fontSize: '12px', color: '#4a5f78', marginTop: '12px' }}>
              Tap the link in the email to sign in. Check spam if you don&apos;t see it.
            </div>
            <button
              onClick={() => { setSent(false); setEmail(''); }}
              style={{
                marginTop: '16px', padding: '8px 16px', borderRadius: '8px',
                border: '1px solid #1e2d3d', color: '#6b7a8d', fontSize: '13px',
                fontWeight: 600, cursor: 'pointer', background: 'transparent',
              }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={mode === 'password' ? handlePassword : handleMagicLink}>
            <div style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                Email Address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@bmgfleet.com"
                autoFocus
                autoComplete="email"
                style={{
                  width: '100%', padding: '14px 16px', borderRadius: '10px',
                  border: '1px solid #1e2d3d', background: '#141e2b', color: '#e8ecf1',
                  fontSize: '16px',
                }}
              />
            </div>

            {mode === 'password' && (
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  style={{
                    width: '100%', padding: '14px 16px', borderRadius: '10px',
                    border: '1px solid #1e2d3d', background: '#141e2b', color: '#e8ecf1',
                    fontSize: '16px',
                  }}
                />
              </div>
            )}

            {error && (
              <div style={{
                padding: '8px 12px', background: 'rgba(239,68,68,0.06)',
                border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px',
                color: '#f87171', fontSize: '12px', marginBottom: '12px',
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!email || (mode === 'password' && !password) || loading}
              style={{
                width: '100%', padding: '14px', borderRadius: '10px',
                background: '#3b82f6',
                color: '#fff', fontSize: '15px', fontWeight: 700,
                opacity: (email && (mode === 'magic' || password) && !loading) ? 1 : 0.5,
              }}
            >
              {loading ? 'Signing in...' : mode === 'password' ? 'Sign In' : 'Send Magic Link'}
            </button>

            <p style={{ textAlign: 'center', fontSize: '12px', color: '#4a5f78', marginTop: '16px' }}>
              {mode === 'password' ? 'Contact admin if you need a password reset' : 'No password needed — we\'ll email you a sign-in link'}
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
