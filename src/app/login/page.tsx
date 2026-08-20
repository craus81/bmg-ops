'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Same-origin path validator — defends the post-login redirect against
// open-redirect abuse (e.g. /login?next=//evil.com).
function safeNextPath(raw: string | null): string {
  if (!raw) return '/home';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/home';
  return raw;
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [requestedRole, setRequestedRole] = useState('installer');
  const [mode, setMode] = useState<'password' | 'magic' | 'signup' | 'forgot'>('password');
  const [sent, setSent] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [signupDone, setSignupDone] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [nextPath, setNextPath] = useState<string>('/home');
  const supabase = createClient();

  useEffect(() => {
    try {
      const raw = new URL(window.location.href).searchParams.get('next');
      setNextPath(safeNextPath(raw));
    } catch {}
  }, []);

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
    const callback = `${window.location.origin}/auth/callback${nextPath !== '/home' ? `?next=${encodeURIComponent(nextPath)}` : ''}`;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: callback } });
    setLoading(false);
    if (error) setError(error.message); else setSent(true);
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true); setError('');
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/reset-password')}`,
    });
    setLoading(false);
    if (error) setError(error.message); else setResetSent(true);
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true); setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) setError(error.message); else window.location.href = nextPath;
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !fullName) return;
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    setLoading(true); setError('');

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          requested_role: requestedRole,
          status: 'pending',
        },
      },
    });

    if (error) {
      setLoading(false);
      setError(error.message);
      return;
    }

    // Create the profile record so admins can see and approve the request
    const userId = data.user?.id;
    if (userId) {
      try {
        await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId,
            email: email.trim(),
            fullName: fullName.trim(),
            requestedRole,
          }),
        });
      } catch (profileErr: any) {
        console.warn('Profile creation failed:', profileErr.message);
        // Don't block signup — auth user exists, profile can be created manually
      }
    }

    setLoading(false);
    setSignupDone(true);
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

        {/* Mode tabs */}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', background: 'var(--login-tab-bg, rgba(255,255,255,0.06))', borderRadius: '10px', padding: '3px' }}>
          {([
            { id: 'password' as const, label: 'Sign In' },
            { id: 'magic' as const, label: 'Magic Link' },
            { id: 'signup' as const, label: 'Request Access' },
          ]).map((m) => (
            <button key={m.id} onClick={() => { setMode(m.id); setError(''); setSignupDone(false); setResetSent(false); }} style={{
              flex: 1, padding: '10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
              background: mode === m.id ? 'var(--login-tab-active-bg, rgba(255,255,255,0.1))' : 'transparent',
              color: mode === m.id ? 'var(--login-tab-active-color, #fff)' : 'var(--login-tab-color, rgba(255,255,255,0.4))',
              transition: 'all 0.2s',
            }}>
              {m.label}
            </button>
          ))}
        </div>

        {/* Magic link sent */}
        {sent ? (
          <div style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: '14px', padding: '24px', textAlign: 'center' }}>
            <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px', color: 'var(--text-muted)' }}>Email Sent</div>
            <div style={{ fontWeight: 700, fontSize: '16px', color: 'var(--success)' }}>Check your email</div>
            <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', marginTop: '6px' }}>
              We sent a sign-in link to <strong style={{ color: '#fff' }}>{email}</strong>
            </div>
            <button onClick={() => { setSent(false); setEmail(''); }} style={{ marginTop: '16px', padding: '10px 20px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.75)', fontSize: '13px', fontWeight: 600, background: 'transparent' }}>
              Use a different email
            </button>
          </div>

        /* Reset link sent */
        ) : resetSent ? (
          <div style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: '14px', padding: '24px', textAlign: 'center' }}>
            <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px', color: 'var(--text-muted)' }}>Email Sent</div>
            <div style={{ fontWeight: 700, fontSize: '16px', color: 'var(--success)' }}>Check your email</div>
            <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', marginTop: '6px' }}>
              We sent a password reset link to <strong style={{ color: '#fff' }}>{email}</strong>
            </div>
            <button onClick={() => { setResetSent(false); setMode('password'); }} style={{ marginTop: '16px', padding: '10px 20px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.75)', fontSize: '13px', fontWeight: 600, background: 'transparent' }}>
              Back to Sign In
            </button>
          </div>

        /* Signup done */
        ) : signupDone ? (
          <div style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: '14px', padding: '24px', textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: '16px', color: 'var(--success)' }}>OK — Request Submitted!</div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '8px', lineHeight: '1.6' }}>
              Your request has been sent to an administrator for approval.
              You&apos;ll receive an email once your access has been approved, and then you can sign in.
            </div>
            <button onClick={() => { setSignupDone(false); setMode('password'); setEmail(''); setPassword(''); setFullName(''); }} style={{ marginTop: '16px', padding: '10px 20px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.75)', fontSize: '13px', fontWeight: 600, background: 'transparent' }}>
              Back to Sign In
            </button>
          </div>

        /* Forms */
        ) : (
          <form onSubmit={mode === 'password' ? handlePassword : mode === 'magic' ? handleMagicLink : mode === 'forgot' ? handleForgot : handleSignup}>
            {mode === 'forgot' && (
              <p style={{ fontSize: '13px', color: 'var(--login-text-muted, rgba(255,255,255,0.5))', marginBottom: '16px', lineHeight: '1.5' }}>
                Enter your email and we&apos;ll send you a link to set a new password.
              </p>
            )}
            {mode === 'signup' && (<>
              <label style={labelStyle}>Full Name</label>
              <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your full name" autoComplete="name" style={inputStyle} />
            </>)}

            <label style={labelStyle}>Email Address</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@bmgfleet.com" autoFocus autoComplete="email" style={inputStyle} />

            {(mode === 'password' || mode === 'signup') && (<>
              <label style={{ ...labelStyle, marginTop: '4px' }}>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'signup' ? 'Create a password (6+ chars)' : 'Enter your password'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} style={inputStyle} />
            </>)}

            {error && (
              <div style={{ padding: '10px 14px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', borderRadius: '10px', color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={!email || (mode === 'password' || mode === 'signup' ? !password : false) || (mode === 'signup' && !fullName) || loading} style={{
              width: '100%', padding: '16px', borderRadius: '12px', background: 'var(--orange)',
              color: '#fff', fontSize: '16px', fontWeight: 700,
              opacity: (email && (mode === 'magic' || mode === 'forgot' || password) && (mode !== 'signup' || fullName) && !loading) ? 1 : 0.5,
              boxShadow: '0 4px 20px rgba(238,49,32,0.3)', transition: 'opacity 0.2s',
            }}>
              {loading ? (mode === 'signup' ? 'Creating...' : mode === 'forgot' ? 'Sending...' : 'Signing in...') : mode === 'password' ? 'Sign In' : mode === 'magic' ? 'Send Magic Link' : mode === 'forgot' ? 'Send Reset Link' : 'Request Access'}
            </button>

            {mode === 'password' ? (
              <button type="button" onClick={() => { setMode('forgot'); setError(''); }} style={{
                display: 'block', margin: '16px auto 0', background: 'transparent', border: 'none',
                fontSize: '12px', color: 'var(--login-text-muted, rgba(255,255,255,0.4))',
                textDecoration: 'underline', cursor: 'pointer',
              }}>
                Forgot password?
              </button>
            ) : mode === 'forgot' ? (
              <button type="button" onClick={() => { setMode('password'); setError(''); }} style={{
                display: 'block', margin: '16px auto 0', background: 'transparent', border: 'none',
                fontSize: '12px', color: 'var(--login-text-muted, rgba(255,255,255,0.4))',
                textDecoration: 'underline', cursor: 'pointer',
              }}>
                Back to Sign In
              </button>
            ) : (
              <p style={{ textAlign: 'center', fontSize: '12px', color: 'var(--login-text-muted, rgba(255,255,255,0.25))', marginTop: '16px' }}>
                {mode === 'magic' ? 'No password needed — we\'ll email you a link' : 'Admin will review your request'}
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
