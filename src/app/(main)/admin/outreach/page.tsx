'use client';

/**
 * Outreach (migration 438; Craig, 2026-10-25). Every Monday each Sales rep
 * gets 25 companies BMG has never dealt with, within 100 miles: fleets from
 * the DOT carrier list, trade contractors from Google business listings.
 * The rep works the list: save one for later, or mark it not a fit. Email
 * drafts for each company come next; nothing here sends anything.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

interface Target {
  id: string;
  source: 'dot' | 'google';
  source_id: string;
  kind: 'fleet' | 'trade';
  company_name: string;
  trade: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  miles: number | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  fleet_size: number | null;
  facts: any;
  week_of: string;
  status: string;
}

interface ListView {
  weekOf: string;
  repId: string;
  batchSize: number;
  isAdmin: boolean;
  reps: { id: string; name: string }[];
  googleReady: boolean;
  targets: Target[];
  savedForLater: Target[];
}

const STATUS: Record<string, { label: string; color: string }> = {
  new: { label: 'New', color: '#60a5fa' },
  draft: { label: 'Draft ready', color: '#60a5fa' },
  call_first: { label: 'Call first', color: '#f59e0b' },
  sent: { label: 'Sent', color: '#94a3b8' },
  replied: { label: 'Replied', color: '#22c55e' },
  booked: { label: 'Meeting booked', color: '#22c55e' },
  later: { label: 'Saved for later', color: '#a78bfa' },
  not_fit: { label: 'Not a fit', color: '#94a3b8' },
  unsubscribed: { label: 'Unsubscribed', color: '#94a3b8' },
};

const fmtWeek = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const safer = (dot: string) =>
  `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${encodeURIComponent(dot)}`;

export default function OutreachPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { isAdmin, isSales, loading: authLoading } = useAuth();
  const [view, setView] = useState<ListView | null>(null);
  const [rep, setRep] = useState<string>(params?.get('rep') || '');
  const [filter, setFilter] = useState<'all' | 'fleet' | 'trade'>('all');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch(`/api/outreach${rep ? `?rep=${encodeURIComponent(rep)}` : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the outreach list');
      setView(data);
    } catch (e: any) {
      setError(e.message || 'Could not load the outreach list');
    }
  }, [rep]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    load();
  }, [authLoading, isAdmin, isSales, load, router]);

  const setStatus = async (t: Target, status: 'new' | 'later' | 'not_fit') => {
    setBusy(t.id);
    setMsg(null);
    try {
      const res = await apiFetch('/api/outreach', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id, status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'That didn\'t save');
      setMsg({ ok: true, text: status === 'later' ? `${t.company_name} saved for later.` : status === 'not_fit' ? `${t.company_name} marked not a fit. It won't come back.` : `${t.company_name} is back on the list.` });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const findNow = async () => {
    setBusy('fill');
    setMsg(null);
    try {
      const res = await apiFetch('/api/cron/outreach-fill');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Finding companies failed');
      const parts = (data.reps || []).map((r: any) => `${r.name} +${r.added}`).join(', ');
      const problems: string[] = data.problems || [];
      setMsg({
        ok: problems.length === 0,
        text: `Added ${data.added} compan${data.added === 1 ? 'y' : 'ies'}${parts ? ` (${parts})` : ''}.${problems.length ? ` ${problems.join(' ')}` : ''}`,
      });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const card: React.CSSProperties = {
    background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px',
  };
  const btn = (color?: string): React.CSSProperties => ({
    padding: '7px 11px', borderRadius: '7px', fontSize: '12px', fontWeight: 700,
    background: 'var(--card)', color: color || 'var(--text-body)',
    border: `1px solid ${color ? `${color}55` : 'var(--border)'}`, cursor: 'pointer',
  });
  const chip = (on: boolean): React.CSSProperties => ({
    ...btn(on ? 'var(--orange)' : undefined),
    background: on ? 'rgba(249,115,22,0.12)' : 'var(--card)',
  });

  if (authLoading || (!view && !error)) {
    return <div style={{ padding: '24px', color: 'var(--text-muted)' }}>Loading outreach…</div>;
  }

  const targets = view?.targets || [];
  const shown = targets.filter(t => filter === 'all' || t.kind === filter);
  const fleets = targets.filter(t => t.kind === 'fleet').length;
  const trades = targets.length - fleets;
  const repName = view?.reps.find(r => r.id === view.repId)?.name;

  const row = (t: Target) => {
    const st = STATUS[t.status] || STATUS.new;
    const done = t.status === 'not_fit';
    return (
      <div key={t.id} style={{ ...card, opacity: done ? 0.6 : 1 }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '240px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>{t.company_name}</span>
              <span style={{ fontSize: '11px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', background: `${st.color}22`, color: st.color }}>{st.label}</span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
              {t.kind === 'fleet' ? 'Fleet' : t.trade || 'Trade contractor'}
              {t.city ? ` · ${t.city}${t.state ? `, ${t.state}` : ''}` : ''}
              {t.miles != null ? ` · ${t.miles} mi` : ''}
              {t.kind === 'fleet' && t.fleet_size ? ` · ${t.fleet_size} trucks` : ''}
              {t.kind === 'fleet' && t.facts?.drivers ? ` · ${t.facts.drivers} drivers` : ''}
              {t.kind === 'trade' && t.facts?.reviews ? ` · ${t.facts.reviews} Google reviews` : ''}
            </div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '13px', marginTop: '6px', color: 'var(--text-body)' }}>
              {t.phone && <a href={`tel:${t.phone.replace(/\D/g, '')}`} style={{ color: 'var(--text-body)' }}>{t.phone}</a>}
              {t.email && <span style={{ userSelect: 'all' }}>{t.email}</span>}
              {t.website && <a href={t.website} target="_blank" rel="noreferrer" style={{ color: '#60a5fa' }}>Website</a>}
              {t.source === 'dot' && <a href={safer(t.source_id)} target="_blank" rel="noreferrer" style={{ color: '#60a5fa' }}>DOT record #{t.source_id}</a>}
              {t.source === 'google' && t.facts?.googleMapsUrl && <a href={t.facts.googleMapsUrl} target="_blank" rel="noreferrer" style={{ color: '#60a5fa' }}>Google listing</a>}
            </div>
            {!t.email && t.status === 'new' && (
              <div style={{ fontSize: '12px', color: '#f59e0b', marginTop: '4px' }}>No email found yet{t.website ? '. The website may have one.' : '. Call instead.'}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {(t.status === 'new') && (
              <>
                <button disabled={busy === t.id} onClick={() => setStatus(t, 'later')} style={btn('#a78bfa')}>Save for later</button>
                <button disabled={busy === t.id} onClick={() => setStatus(t, 'not_fit')} style={btn('#94a3b8')}>Not a fit</button>
              </>
            )}
            {(t.status === 'later' || t.status === 'not_fit') && (
              <button disabled={busy === t.id} onClick={() => setStatus(t, 'new')} style={btn()}>Put back</button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: '18px 16px 90px', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' }}>
        <a href="/admin/prospects?tab=prospects" style={{ fontSize: '13px', color: 'var(--text-muted)', textDecoration: 'none' }}>← Prospects</a>
      </div>
      <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>
        Outreach{view ? ` · week of ${fmtWeek(view.weekOf)}` : ''}
      </div>
      <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.5, maxWidth: '72ch' }}>
        Every Monday each sales rep gets {view?.batchSize || 25} companies BMG has never worked with, within 100 miles of O&apos;Fallon:
        fleets from the federal DOT carrier list and trade contractors from Google business listings. Nothing is emailed from here.
        Next, FleetSuite will write an email for each one for you to read, edit and send.
      </div>

      {view?.isAdmin && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
          <label htmlFor="outreach-rep" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Rep</label>
          <select id="outreach-rep" value={rep || view.repId} onChange={e => setRep(e.target.value)} style={{
            padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-body)', fontSize: '13px',
          }}>
            {!view.reps.some(r => r.id === view.repId) && <option value={view.repId}>Me</option>}
            {view.reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button onClick={findNow} disabled={busy === 'fill'} style={{ ...btn('#22c55e'), marginLeft: 'auto' }}>
            {busy === 'fill' ? 'Finding companies… (up to a few minutes)' : 'Find companies now'}
          </button>
        </div>
      )}

      {view && !view.googleReady && (
        <div style={{ ...card, borderColor: 'var(--error-border)', color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>
          Trade contractors need a Google Maps API key (GOOGLE_MAPS_API_KEY in Vercel). Until it&apos;s added, every batch is fleets only.
        </div>
      )}

      {msg && (
        <div style={{
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', fontSize: '13px', fontWeight: 600,
          background: msg.ok ? 'var(--success-bg)' : 'var(--error-bg)',
          border: `1px solid ${msg.ok ? 'var(--success-border)' : 'var(--error-border)'}`,
          color: msg.ok ? 'var(--success)' : 'var(--error)',
        }}>{msg.text}</div>
      )}

      {error && (
        <div style={{ ...card, borderColor: 'var(--error-border)', color: 'var(--error)', fontSize: '13px' }}>{error}</div>
      )}

      {view && (
        <>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
            <button onClick={() => setFilter('all')} style={chip(filter === 'all')}>All {targets.length}</button>
            <button onClick={() => setFilter('fleet')} style={chip(filter === 'fleet')}>Fleets {fleets}</button>
            <button onClick={() => setFilter('trade')} style={chip(filter === 'trade')}>Trades {trades}</button>
            {repName && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{repName}&apos;s list</span>}
          </div>

          {targets.length === 0 && (
            <div style={{ ...card, color: 'var(--text-muted)', fontSize: '13px' }}>
              No companies for this week yet. The list fills every Monday morning{view.isAdmin ? ', or tap Find companies now' : ''}.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {shown.map(row)}
          </div>

          {view.savedForLater.length > 0 && (
            <>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', margin: '22px 0 8px' }}>
                Saved for later from earlier weeks ({view.savedForLater.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {view.savedForLater.map(row)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
