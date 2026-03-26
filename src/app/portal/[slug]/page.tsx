'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import type { PortalCustomer } from '@/lib/types';

export default function PortalLoginPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const supabase = createClient();

  const [portalCustomer, setPortalCustomer] = useState<PortalCustomer | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [brandLoaded, setBrandLoaded] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load customer branding from slug
  useEffect(() => {
    fetch(`/api/portal/${slug}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setNotFound(true); }
        else { setPortalCustomer(data); }
        setBrandLoaded(true);
      })
      .catch(() => { setNotFound(true); setBrandLoaded(true); });
  }, [slug]);

  // If already logged in and belongs to this portal, redirect to dashboard
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return;
      if (!portalCustomer) return;
      // Check if this user belongs to this portal customer
      const { data: pcu } = await supabase
        .from('portal_customer_users')
        .select('id')
        .eq('portal_customer_id', portalCustomer.id)
        .eq('user_id', session.user.id)
        .maybeSingle();
      if (pcu) router.replace(`/portal/${slug}/dashboard`);
    });
  }, [portalCustomer]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!portalCustomer) return;
    setLoading(true); setError('');

    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setLoading(false);
      setError('Invalid email or password');
      return;
    }

    const userId = data.user?.id;
    if (!userId) { setLoading(false); setError('Sign in failed'); return; }

    // Verify the user belongs to this portal customer
    const { data: pcu } = await supabase
      .from('portal_customer_users')
      .select('id')
      .eq('portal_customer_id', portalCustomer.id)
      .eq('user_id', userId)
      .maybeSingle();

    if (!pcu) {
      await supabase.auth.signOut();
      setLoading(false);
      setError('Your account is not authorized for this portal');
      return;
    }

    router.replace(`/portal/${slug}/dashboard`);
  };

  const accentColor = portalCustomer?.primary_color || '#EE3120';

  if (!brandLoaded) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a1017' }}>
        <div style={{ width: '28px', height: '28px', border: '2px solid rgba(255,255,255,0.1)', borderTopColor: '#EE3120', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (notFound) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a1017', padding: '20px' }}>
        <div style={{ textAlign: 'center', maxWidth: '320px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🔍</div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#fff', marginBottom: '8px' }}>Portal Not Found</div>
          <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.4)' }}>
            The portal at <code style={{ color: 'rgba(255,255,255,0.6)' }}>/portal/{slug}</code> doesn&apos;t exist.
          </div>
        </div>
      </div>
    );
  }

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '11px', fontWeight: 700,
    color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase',
    letterSpacing: '0.8px', marginBottom: '8px',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '14px 18px', borderRadius: '12px',
    border: '1px solid rgba(255,255,255,0.1)',
    background: 'rgba(255,255,255,0.06)',
    color: '#fff', fontSize: '16px', marginBottom: '12px',
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px',
      background: 'linear-gradient(165deg, #152838 0%, #0f1e2a 40%, #0a1520 100%)',
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        {/* Customer logo + BMG branding */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          {portalCustomer?.logo_url ? (
            <img
              src={portalCustomer.logo_url}
              alt={portalCustomer.company_name}
              style={{ maxHeight: '72px', maxWidth: '220px', objectFit: 'contain', marginBottom: '16px' }}
            />
          ) : (
            <div style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: '72px', height: '72px', borderRadius: '16px',
              background: accentColor, fontSize: '28px', fontWeight: 900, color: '#fff',
              marginBottom: '16px',
            }}>
              {portalCustomer?.company_name.charAt(0)}
            </div>
          )}
          <div style={{ fontSize: '18px', fontWeight: 800, color: '#fff' }}>
            {portalCustomer?.company_name}
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', marginTop: '4px' }}>
            Graphics Ordering Portal
          </div>
          {/* BMG attribution */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginTop: '16px' }}>
            <div style={{ height: '1px', width: '40px', background: 'rgba(255,255,255,0.1)' }} />
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', whiteSpace: 'nowrap' }}>
              Powered by BMG Fleet
            </div>
            <div style={{ height: '1px', width: '40px', background: 'rgba(255,255,255,0.1)' }} />
          </div>
        </div>

        {/* Sign-in form */}
        <form onSubmit={handleSignIn}>
          <label style={labelStyle}>Email Address</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoFocus
            autoComplete="email"
            style={inputStyle}
          />

          <label style={{ ...labelStyle, marginTop: '4px' }}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            autoComplete="current-password"
            style={inputStyle}
          />

          {error && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: '10px', color: '#f87171',
              fontSize: '13px', marginBottom: '12px',
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!email || !password || loading}
            style={{
              width: '100%', padding: '16px', borderRadius: '12px',
              background: accentColor,
              color: '#fff', fontSize: '16px', fontWeight: 700,
              border: 'none', cursor: loading ? 'wait' : 'pointer',
              opacity: !email || !password || loading ? 0.5 : 1,
              boxShadow: `0 4px 20px ${accentColor}44`,
              transition: 'opacity 0.2s',
            }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

          <p style={{ textAlign: 'center', fontSize: '12px', color: 'rgba(255,255,255,0.25)', marginTop: '16px' }}>
            Contact your BMG Fleet representative for access
          </p>
        </form>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        input::placeholder { color: rgba(255,255,255,0.3); }
        input:focus { outline: none; border-color: ${accentColor}88; }
        button { border: none; }
      `}</style>
    </div>
  );
}
