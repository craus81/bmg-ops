'use client';

/**
 * The Install card on a graphics job (Valarie's chain, 2026-10-24): set the
 * install date and arrival time, which puts the job on the install
 * calendar, then press "Send install confirmation" to email the client and
 * the rep through the standard compose screen. Nothing sends by itself.
 *
 * Shown for jobs we install (onsite or at our shop) and for any job that
 * already has an install date. ?schedule=1 (the "Schedule install" alert
 * and Home's Needs install date list) scrolls here with the date open.
 */

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';
import { isInstalledJob, longDate } from '@/lib/install-scheduling-state';

export interface InstallCardJob {
  id: string;
  status: string;
  customer: string | null;
  delivery_method?: string | null;
  scheduled_install_date: string | null;
  install_arrival_time?: string | null;
  install_confirmation_sent_at?: string | null;
}

type Patch = Partial<Pick<InstallCardJob, 'scheduled_install_date' | 'install_arrival_time' | 'install_confirmation_sent_at'>>;

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px 16px' };
const labelStyle: React.CSSProperties = {
  fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
  textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 10px', borderRadius: '8px',
  border: '1px solid var(--border)', background: 'var(--bg)',
  color: 'var(--text-body)', fontSize: '14px',
};
const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({
  padding: '10px 16px', borderRadius: '10px', border: 'none', background: bg, color: fg,
  fontSize: '13px', fontWeight: 800, cursor: 'pointer',
});

const ymd = (v: string | null | undefined) => (v && v !== 'N/A' ? String(v).slice(0, 10) : '');
const sentLabel = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

export default function GraphicsInstallCard({ job, onUpdated }: { job: InstallCardJob; onUpdated: (patch: Patch) => void }) {
  const { user } = useAuth();
  const ref = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  const savedDate = ymd(job.scheduled_install_date);
  const savedTime = job.install_arrival_time || '';
  const [date, setDate] = useState(savedDate);
  const [time, setTime] = useState(savedTime);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [compose, setCompose] = useState<{ to: string; cc: string[]; customerId: string | null } | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => { setDate(ymd(job.scheduled_install_date)); setTime(job.install_arrival_time || ''); }, [job.scheduled_install_date, job.install_arrival_time]);

  // ?schedule=1: scroll here and open the date.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('schedule') !== '1') return;
    const t = setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (!ymd(job.scheduled_install_date)) dateRef.current?.focus();
    }, 300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page load
  }, []);

  const show = isInstalledJob(job) || !!savedDate;
  if (!show) return null;

  const dirty = date !== savedDate || time.trim() !== savedTime;

  const save = async () => {
    setSaving(true); setError(''); setNote('');
    try {
      const res = await apiFetch(`/api/graphics-jobs/${job.id}/install-schedule`, {
        method: 'POST',
        body: JSON.stringify({ date: date || null, arrivalTime: time.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || `Save failed (HTTP ${res.status}).`); return; }
      onUpdated({ scheduled_install_date: data.scheduled_install_date, install_arrival_time: data.install_arrival_time });
      if (!data.scheduled_install_date) setNote('Install date cleared and taken off the install calendar.');
      else if (data.calendar?.synced) setNote('✓ Saved and on the install calendar.');
      else setError('Saved, but the install calendar did not take it. It will retry on its own within 15 minutes.');
    } catch {
      setError('Network error. The date was not saved.');
    } finally {
      setSaving(false);
    }
  };

  // Open the compose screen with the client prefilled and the rep on Cc.
  const openConfirm = async () => {
    setOpening(true); setError('');
    try {
      const res = await apiFetch(`/api/graphics-jobs/${job.id}/install-confirmation`, {
        method: 'POST', body: JSON.stringify({ preview: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || `Could not open the email (HTTP ${res.status}).`); return; }
      const rep = (data.repEmail || '').toLowerCase();
      const me = (user?.email || '').toLowerCase();
      setCompose({ to: data.to || '', cc: rep && rep !== me ? [rep] : [], customerId: data.customerId || null });
    } catch {
      setError('Network error. Try again.');
    } finally {
      setOpening(false);
    }
  };

  const fetchPreview = async (f: EmailComposeFields) => {
    try {
      const res = await apiFetch(`/api/graphics-jobs/${job.id}/install-confirmation`, {
        method: 'POST',
        body: JSON.stringify({ preview: true, emails: f.emails, cc: f.cc, message: f.message || undefined }),
      });
      const data = await res.json();
      if (res.ok && data.preview) return { preview: { to: data.to ?? null, subject: data.subject, html: data.html } };
      return { error: data.error || 'Preview failed' };
    } catch {
      return { error: 'Network error. Try again.' };
    }
  };

  const send = async (f: EmailComposeFields): Promise<{ ok: boolean }> => {
    try {
      const res = await apiFetch(`/api/graphics-jobs/${job.id}/install-confirmation`, {
        method: 'POST',
        body: JSON.stringify({ emails: f.emails, cc: f.cc, bccSelf: f.bccSelf, message: f.message || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || `Send failed (HTTP ${res.status}).`); return { ok: false }; }
      onUpdated({ install_confirmation_sent_at: data.sentAt });
      const e = data.dispatch?.email;
      setNote(`✓ Install confirmation sent to ${e?.target || f.emails.join(', ')}${e?.cc ? `, cc ${e.cc}` : ''}.`);
      return { ok: true };
    } catch {
      setError('Network error. The email was not sent.');
      return { ok: false };
    }
  };

  return (
    <div ref={ref} style={card} id="install">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>📅 Install</div>
        {!savedDate && <span style={{ fontSize: '11px', fontWeight: 800, color: '#f59e0b' }}>Needs install date</span>}
        {savedDate && <span style={{ fontSize: '11px', fontWeight: 700, color: '#22d3ee' }}>{longDate(savedDate)}{savedTime ? ` · ${savedTime}` : ''}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
        <label>
          <div style={labelStyle}>Install date</div>
          <input id="install-date" ref={dateRef} type="date" style={inputStyle} value={date} onChange={e => setDate(e.target.value)} />
        </label>
        <label>
          <div style={labelStyle}>Arrival time (optional)</div>
          <input id="install-time" type="text" style={inputStyle} value={time} placeholder="8:00 AM" maxLength={40} onChange={e => setTime(e.target.value)} />
        </label>
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '12px' }}>
        {(dirty || !savedDate) && (
          <button onClick={save} disabled={saving || !dirty} style={{ ...btn('#3b82f6'), opacity: saving || !dirty ? 0.6 : 1 }}>
            {saving ? 'Saving…' : savedDate && !date ? 'Clear install date' : 'Save install date'}
          </button>
        )}
        {savedDate && !dirty && (
          <button onClick={openConfirm} disabled={opening} style={{ ...btn('#16a34a'), opacity: opening ? 0.6 : 1 }}>
            {opening ? 'Opening…' : job.install_confirmation_sent_at ? 'Send install confirmation again' : 'Send install confirmation'}
          </button>
        )}
        {job.install_confirmation_sent_at && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Confirmation sent {sentLabel(job.install_confirmation_sent_at)}</span>
        )}
      </div>

      {note && <div style={{ marginTop: '10px', fontSize: '12px', fontWeight: 700, color: '#22c55e' }}>{note}</div>}
      {error && <div style={{ marginTop: '10px', fontSize: '12px', fontWeight: 700, color: '#ef4444' }}>{error}</div>}
      {savedDate && !job.install_confirmation_sent_at && !dirty && (
        <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
          Nothing goes to the client until you press Send install confirmation.
        </div>
      )}

      {compose && (
        <EmailComposeModal
          title="Send Install Confirmation"
          sendLabel="Send confirmation"
          messagePlaceholder="Optional note to the client, shown at the top of the email…"
          initialTo={compose.to}
          initialCc={compose.cc}
          customerId={compose.customerId}
          stateKey={`install-confirmation:${job.id}`}
          fetchPreview={fetchPreview}
          onSend={send}
          onClose={() => setCompose(null)}
          intro={
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              The client gets the date, time and place with a calendar file. The rep is on Cc.
            </div>
          }
        />
      )}
    </div>
  );
}
