'use client';

/**
 * Public booking page (R5-17) — magic-link, no login, like /approve. The
 * token decides what it books: a vehicle's pickup (completion email CTA)
 * or an approved estimate's drop-off (approval landing page CTA). The same
 * link reschedules or cancels. All slot math is server-side; this page
 * renders what /api/book returns and posts the choice.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';

interface DaySlots { day: string; times: string[] }
interface BookingView {
  status: string;
  kind?: 'pickup' | 'dropoff';
  label?: string;
  customerName?: string | null;
  booking?: { slotDate: string; slotTime: string; contactName: string | null; contactPhone: string | null; notes: string | null } | null;
  slots?: DaySlots[];
  slotMinutes?: number;
}

const fmt12h = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const fmtDay = (day: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Date(day + 'T12:00:00').toLocaleDateString([], opts);

export default function BookingPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token || '';

  const [view, setView] = useState<BookingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickDay, setPickDay] = useState<string | null>(null);
  const [pickTime, setPickTime] = useState<string | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'booked' | 'cancelled' | null>(null);
  const [changing, setChanging] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/book/${encodeURIComponent(token)}`);
      const json = await res.json();
      if (!res.ok && !json.status) { setView({ status: 'error' }); return; }
      setView(json);
      if (json.booking) {
        setContactName(json.booking.contactName || '');
        setContactPhone(json.booking.contactPhone || '');
        setNotes(json.booking.notes || '');
      }
    } catch {
      setView({ status: 'error' });
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const submit = async (cancel?: boolean) => {
    if (busy) return;
    if (!cancel && (!pickDay || !pickTime)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/book/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cancel
          ? { cancel: true }
          : { slotDate: pickDay, slotTime: pickTime, contactName: contactName.trim() || undefined, contactPhone: contactPhone.trim() || undefined, notes: notes.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Something went wrong — please try again.');
        if (res.status === 409) await load(); // slot taken → refresh the grid
        return;
      }
      setDone(cancel ? 'cancelled' : 'booked');
      setChanging(false);
      await load();
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  };

  const noun = view?.kind === 'pickup' ? 'pickup' : 'drop-off';
  const heading = view?.kind === 'pickup' ? 'Book your pickup' : 'Schedule your drop-off';

  const frame = (children: React.ReactNode) => (
    <div style={{ minHeight: 'calc(100vh / var(--ts))', background: '#f1f5f9', padding: '20px 16px' }}>
      <div style={{ maxWidth: '560px', margin: '0 auto', background: '#fff', borderRadius: '14px', padding: '22px', border: '1px solid #e2e8f0', color: '#0f172a' }}>
        {children}
        <div style={{ textAlign: 'center', marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e2e8f0', fontSize: '11px', color: '#94a3b8' }}>
          BMG Fleet Installations LLC · FleetSuite
        </div>
      </div>
    </div>
  );

  if (!view) return frame(<div style={{ color: '#64748b' }}>Loading…</div>);
  if (view.status === 'invalid' || view.status === 'error') {
    return frame(<div>This booking link isn&apos;t valid. Please contact BMG Fleet Installations.</div>);
  }
  if (view.status === 'expired') return frame(<div>This link has expired — please ask us to send a fresh one.</div>);
  if (view.status === 'not_approved') return frame(<div>Drop-off scheduling opens once the estimate is approved.</div>);
  if (view.status === 'closed') {
    return frame(<div>{view.kind === 'pickup' ? 'This vehicle has already been picked up.' : 'This order is closed.'} Questions? Contact BMG Fleet Installations.</div>);
  }
  if (view.status === 'disabled') return frame(<div>Online booking is currently unavailable — please contact us to schedule.</div>);

  const current = view.booking;
  const showGrid = !current || changing;

  return frame(
    <div>
      <div style={{ fontSize: '18px', fontWeight: 800 }}>{heading}</div>
      <div style={{ fontSize: '13px', color: '#64748b', marginTop: '2px', marginBottom: '14px' }}>
        {view.label}{view.customerName ? ` · ${view.customerName}` : ''}
      </div>

      {done === 'booked' && current && !changing && (
        <div style={{ background: '#dcfce7', border: '1px solid #86efac', color: '#166534', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', fontWeight: 700, marginBottom: '12px' }}>
          ✓ Booked — a confirmation is on its way.
        </div>
      )}
      {done === 'cancelled' && !current && (
        <div style={{ background: '#fef9c3', border: '1px solid #fde047', color: '#854d0e', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', fontWeight: 700, marginBottom: '12px' }}>
          Booking cancelled. Pick a new time below whenever you&apos;re ready.
        </div>
      )}

      {current && !changing && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Your {noun}</div>
          <div style={{ fontSize: '16px', fontWeight: 800, marginTop: '4px' }}>
            {fmtDay(current.slotDate, { weekday: 'long', month: 'long', day: 'numeric' })} · {fmt12h(current.slotTime)}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <button onClick={() => { setChanging(true); setPickDay(current.slotDate); setPickTime(null); setDone(null); }} style={{
              padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
              background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', cursor: 'pointer',
            }}>Change time</button>
            <button onClick={() => submit(true)} disabled={busy} style={{
              padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
              background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', cursor: 'pointer', opacity: busy ? 0.6 : 1,
            }}>{busy ? 'Working…' : 'Cancel booking'}</button>
          </div>
        </div>
      )}

      {showGrid && (
        <>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Pick a day</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
            {(view.slots || []).map(d => (
              <button key={d.day} onClick={() => { setPickDay(d.day); setPickTime(null); }} style={{
                padding: '8px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                background: pickDay === d.day ? '#1d4ed8' : '#f8fafc',
                color: pickDay === d.day ? '#fff' : '#334155',
                border: `1px solid ${pickDay === d.day ? '#1d4ed8' : '#e2e8f0'}`,
              }}>{fmtDay(d.day)}</button>
            ))}
            {(view.slots || []).length === 0 && (
              <div style={{ fontSize: '12px', color: '#64748b' }}>No open slots right now — please contact us to schedule.</div>
            )}
          </div>

          {pickDay && (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Pick a time</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
                {(view.slots || []).find(d => d.day === pickDay)?.times.map(t => (
                  <button key={t} onClick={() => setPickTime(t)} style={{
                    padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                    background: pickTime === t ? '#1d4ed8' : '#f8fafc',
                    color: pickTime === t ? '#fff' : '#334155',
                    border: `1px solid ${pickTime === t ? '#1d4ed8' : '#e2e8f0'}`,
                  }}>{fmt12h(t)}</button>
                ))}
              </div>
            </>
          )}

          {pickTime && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
              <input value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Who's coming? (name, optional)" maxLength={80}
                style={{ padding: '10px', borderRadius: '8px', fontSize: '13px', border: '1px solid #e2e8f0' }} />
              <input value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="Phone for day-of contact (optional)" maxLength={30}
                style={{ padding: '10px', borderRadius: '8px', fontSize: '13px', border: '1px solid #e2e8f0' }} />
              <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything we should know? (optional)" maxLength={500} rows={2}
                style={{ padding: '10px', borderRadius: '8px', fontSize: '13px', border: '1px solid #e2e8f0', resize: 'vertical', fontFamily: 'inherit' }} />
            </div>
          )}

          {error && <div style={{ fontSize: '12px', color: '#b91c1c', marginBottom: '10px' }}>{error}</div>}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => submit()} disabled={busy || !pickDay || !pickTime} style={{
              flex: 1, padding: '12px', borderRadius: '10px', fontSize: '14px', fontWeight: 800,
              background: busy || !pickDay || !pickTime ? '#e2e8f0' : '#16a34a',
              color: busy || !pickDay || !pickTime ? '#94a3b8' : '#fff',
              border: 'none', cursor: busy || !pickDay || !pickTime ? 'default' : 'pointer',
            }}>{busy ? 'Booking…' : current ? `Confirm new ${noun} time` : `Book ${noun}`}</button>
            {changing && (
              <button onClick={() => { setChanging(false); setError(null); }} style={{
                padding: '12px 16px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                background: '#fff', color: '#64748b', border: '1px solid #e2e8f0', cursor: 'pointer',
              }}>Keep current</button>
            )}
          </div>
        </>
      )}
    </div>,
  );
}
