'use client';

/**
 * Public "Pick a time" / "Have <rep> call me" page (migration 440), opened
 * from the two buttons on an Outreach email. No login. ?call=1 opens on the
 * call-back form. All slot math is server-side; this page shows what
 * /api/meet returns and posts the choice.
 */

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { LEGAL } from '@/lib/legal';

interface MeetView {
  status: 'ready' | 'invalid' | 'error';
  company?: string;
  repName?: string;
  repFirst?: string;
  minutes?: number;
  booked?: string | null;
  callback?: { phone: string | null; when: string | null } | null;
  slots?: { day: string; times: string[] }[];
}

const fmt12h = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const fmtDay = (day: string, long = false) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', long
    ? { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }
    : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtInstant = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

const BLUE = '#1d4ed8';

export default function MeetPage() {
  const params = useParams<{ token: string }>();
  const search = useSearchParams();
  const token = params?.token || '';
  const [view, setView] = useState<MeetView | null>(null);
  const [mode, setMode] = useState<'time' | 'call'>(search?.get('call') ? 'call' : 'time');
  const [day, setDay] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = () => fetch(`/api/meet/${encodeURIComponent(token)}`)
    .then(async r => {
      const j = await r.json().catch(() => ({}));
      if (r.status === 404) return setView({ status: 'invalid' });
      if (!r.ok) return setView({ status: 'error' });
      setView(j);
      if (j.slots?.[0]) setDay(d => d || j.slots[0].day);
    })
    .catch(() => setView({ status: 'error' }));

  useEffect(() => {
    if (token) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const submit = async () => {
    setError(null);
    if (phone.replace(/\D/g, '').length < 7) { setError('Add a phone number so we can call you.'); return; }
    if (mode === 'time' && (!day || !time)) { setError('Pick a day and a time.'); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/meet/${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'time'
          ? { action: 'book', day, time, name: name || undefined, phone }
          : { action: 'call', name: name || undefined, phone, when: when || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) { setTime(null); await load(); }
        throw new Error(j.error || 'That didn\'t go through. Try again.');
      }
      setDone(mode === 'time'
        ? `You're booked for ${j.label}. ${view?.repFirst} will call you at ${phone}.`
        : `Got it. ${view?.repFirst} will call you at ${phone}${when ? ` (${when})` : ''}.`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const frame = (children: React.ReactNode) => (
    <div style={{ minHeight: 'calc(100vh / var(--ts))', background: '#f1f5f9', padding: '20px 16px' }}>
      <div style={{ maxWidth: '560px', margin: '0 auto', background: '#fff', borderRadius: '14px', padding: '22px', border: '1px solid #e2e8f0', color: '#0f172a', fontSize: '15px', lineHeight: 1.5 }}>
        {children}
        <div style={{ textAlign: 'center', marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e2e8f0', fontSize: '11px', color: '#94a3b8' }}>
          {LEGAL.entityName} · {LEGAL.address}
        </div>
      </div>
    </div>
  );

  const input: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '15px', boxSizing: 'border-box', background: '#fff', color: '#0f172a',
  };
  const pill = (on: boolean): React.CSSProperties => ({
    padding: '9px 12px', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
    background: on ? BLUE : '#fff', color: on ? '#fff' : BLUE, border: `1px solid ${BLUE}`,
  });

  if (!view) return frame(<div style={{ color: '#64748b' }}>Loading…</div>);
  if (view.status === 'invalid') return frame(<div>This link isn&apos;t valid anymore. Reply to the email and we&apos;ll set up a time.</div>);
  if (view.status === 'error') return frame(<div style={{ color: '#b91c1c', fontWeight: 600 }}>This page couldn&apos;t load. Try again in a minute, or reply to the email.</div>);

  const who = view.repFirst || 'us';

  if (done) {
    return frame(
      <div>
        <div style={{ fontSize: '19px', fontWeight: 800, marginBottom: '8px' }}>Thanks</div>
        <div>{done}</div>
      </div>,
    );
  }

  if (view.booked) {
    return frame(
      <div>
        <div style={{ fontSize: '19px', fontWeight: 800, marginBottom: '8px' }}>You&apos;re booked</div>
        <div>{who} will call you {fmtInstant(view.booked)} (Central time). Need a different time? Reply to the email.</div>
      </div>,
    );
  }

  const slotsForDay = view.slots?.find(d => d.day === day)?.times || [];

  return frame(
    <div>
      <div style={{ fontSize: '19px', fontWeight: 800 }}>Talk with {view.repName} at BMG Fleet</div>
      <div style={{ fontSize: '14px', color: '#64748b', margin: '2px 0 16px' }}>
        {view.company} · a {view.minutes}-minute phone call. No account needed.
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <button onClick={() => setMode('time')} style={pill(mode === 'time')}>Pick a time</button>
        <button onClick={() => setMode('call')} style={pill(mode === 'call')}>Have {who} call me</button>
      </div>

      {view.callback && mode === 'call' && (
        <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '12px' }}>
          You already asked for a call at {view.callback.phone}. Send this again to change the number or time.
        </div>
      )}

      {mode === 'time' && (
        <>
          {(view.slots || []).length === 0 ? (
            <div style={{ marginBottom: '14px' }}>No open times right now. Tap &ldquo;Have {who} call me&rdquo; instead.</div>
          ) : (
            <>
              <div style={{ fontSize: '13px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Day (Central time)</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
                {(view.slots || []).map(d => (
                  <button key={d.day} onClick={() => { setDay(d.day); setTime(null); }} style={pill(day === d.day)}>{fmtDay(d.day)}</button>
                ))}
              </div>
              {day && (
                <>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Time on {fmtDay(day, true)}</div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
                    {slotsForDay.map(t => <button key={t} onClick={() => setTime(t)} style={pill(time === t)}>{fmt12h(t)}</button>)}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '14px' }}>
        <label>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#334155', marginBottom: '4px' }}>Best phone number</div>
          <input id="meet-phone" type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} style={input} />
        </label>
        <label>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#334155', marginBottom: '4px' }}>Your name (optional)</div>
          <input id="meet-name" value={name} onChange={e => setName(e.target.value)} style={input} />
        </label>
        {mode === 'call' && (
          <label>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#334155', marginBottom: '4px' }}>Best time to call (optional)</div>
            <input id="meet-when" value={when} onChange={e => setWhen(e.target.value)} placeholder="Mornings before 10" style={input} />
          </label>
        )}
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: '10px', padding: '10px 12px', fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>
          {error}
        </div>
      )}

      <button onClick={submit} disabled={busy || (mode === 'time' && (view.slots || []).length === 0)} style={{
        padding: '12px 18px', borderRadius: '10px', fontSize: '15px', fontWeight: 700, background: BLUE, color: '#fff', border: 'none', cursor: 'pointer', opacity: busy ? 0.6 : 1,
      }}>
        {busy ? 'Sending…' : mode === 'time' ? (time && day ? `Book ${fmtDay(day)} at ${fmt12h(time)}` : 'Book this time') : `Ask ${who} to call me`}
      </button>
    </div>,
  );
}
