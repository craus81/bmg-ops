'use client';

/**
 * Public unsubscribe page (migration 437) — the footer link on BMG
 * marketing email. No login, one button. Opening the page changes nothing:
 * mail scanners open every link, so only the button's POST opts out.
 */

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { LEGAL } from '@/lib/legal';

type View = { status: 'loading' | 'ready' | 'unsubscribed' | 'invalid' | 'error'; email?: string };

export default function UnsubscribePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token || '';
  const [view, setView] = useState<View>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justDone, setJustDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/unsubscribe/${encodeURIComponent(token)}`)
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (r.status === 404) return setView({ status: 'invalid' });
        if (!r.ok) return setView({ status: 'error' });
        setView({ status: j.status, email: j.email });
      })
      .catch(() => setView({ status: 'error' }));
  }, [token]);

  const unsubscribe = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/unsubscribe/${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'That didn\'t go through. Try again.');
      setView({ status: 'unsubscribed', email: j.email || view.email });
      setJustDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const frame = (children: React.ReactNode) => (
    <div style={{ minHeight: 'calc(100vh / var(--ts))', background: '#f1f5f9', padding: '20px 16px' }}>
      <div style={{ maxWidth: '520px', margin: '40px auto 0', background: '#fff', borderRadius: '14px', padding: '24px', border: '1px solid #e2e8f0', color: '#0f172a', fontSize: '15px', lineHeight: 1.5 }}>
        {children}
        <div style={{ textAlign: 'center', marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e2e8f0', fontSize: '11px', color: '#94a3b8' }}>
          {LEGAL.entityName} · {LEGAL.address}
        </div>
      </div>
    </div>
  );

  if (view.status === 'loading') return frame(<div style={{ color: '#64748b' }}>Loading…</div>);
  if (view.status === 'invalid') {
    return frame(<div>This unsubscribe link isn&apos;t valid. Reply to the email and ask us to stop, and we will.</div>);
  }
  if (view.status === 'error') {
    return frame(<div style={{ color: '#b91c1c', fontWeight: 600 }}>This page couldn&apos;t load. Try again in a minute, or reply to the email and ask us to stop.</div>);
  }
  if (view.status === 'unsubscribed') {
    return frame(
      <div>
        <div style={{ fontSize: '18px', fontWeight: 800, marginBottom: '8px' }}>
          {justDone ? 'You\'re unsubscribed' : 'You\'re already unsubscribed'}
        </div>
        <div>BMG Fleet won&apos;t send marketing email to {view.email} again.</div>
        <div style={{ color: '#64748b', fontSize: '13px', marginTop: '10px' }}>
          If you&apos;re a customer, you&apos;ll still get emails about your own orders, like estimates and invoices.
        </div>
      </div>,
    );
  }

  return frame(
    <div>
      <div style={{ fontSize: '18px', fontWeight: 800, marginBottom: '8px' }}>Unsubscribe from BMG Fleet emails</div>
      <div style={{ marginBottom: '16px' }}>Stop marketing email to <b>{view.email}</b>?</div>
      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: '10px', padding: '10px 12px', fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>
          {error}
        </div>
      )}
      <button onClick={unsubscribe} disabled={busy} style={{
        padding: '12px 18px', borderRadius: '10px', fontSize: '15px', fontWeight: 700,
        background: '#1d4ed8', color: '#fff', border: 'none', cursor: 'pointer', opacity: busy ? 0.6 : 1,
      }}>{busy ? 'Unsubscribing…' : 'Unsubscribe'}</button>
    </div>,
  );
}
