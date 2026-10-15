'use client';

/**
 * A customer's QC fix link (migration 381) — Masterack's QC team reports an
 * issue on a vehicle BMG finished: last 6 of the VIN, a VIN photo, issue
 * photos and optional comments (the date is stamped). Below the form, their
 * team's reports with the fix-by date BMG set, and when each was fixed.
 *
 * No login: the token in the URL is the credential. Anyone with the link can
 * report; each person types their name once and this phone remembers it.
 * Fixed light styling, like the portal and approval pages — this renders
 * outside the app's theme, on the customer's own devices.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { shrinkPhotoForUpload } from '@/lib/photo-upload-shrink';
import { QC_MAX_PHOTOS, fmtQcDate, normalizeLast6, qcStatusLabel, type QcStatus } from '@/lib/qc-fixes';

interface Report {
  id: string;
  vin_last6: string;
  vehicle_label: string | null;
  reported_by_name: string;
  comments: string | null;
  status: QcStatus;
  fix_by: string | null;
  note_to_customer: string | null;
  fixed_at: string | null;
  created_at: string;
  photos: Array<{ id: string; kind: 'vin' | 'issue' | 'fix' }>;
}

interface Picked {
  key: string;
  preview: string;
  id: string | null;
  error: string | null;
}

const NAME_KEY = 'bmg-qc-name';
const readName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
const saveName = (n: string) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ } };

const page: React.CSSProperties = { minHeight: 'calc(100vh / var(--ts, 1))', background: '#f3f4f6', color: '#1a2b36', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' };
const wrap: React.CSSProperties = { maxWidth: '640px', margin: '0 auto', padding: '16px 16px 48px' };
const card: React.CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: '14px', padding: '14px', marginBottom: '12px' };
const label: React.CSSProperties = { display: 'block', fontSize: '14px', fontWeight: 800, marginBottom: '6px' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: '10px', padding: '11px 12px', fontSize: '16px', background: '#fff', color: '#111', fontFamily: 'inherit' };
const muted: React.CSSProperties = { fontSize: '12px', color: '#6b7280' };
const CHIP: Record<QcStatus, React.CSSProperties> = {
  new: { background: '#fee2e2', color: '#b91c1c' },
  scheduled: { background: '#fef3c7', color: '#92400e' },
  fixed: { background: '#dcfce7', color: '#166534' },
};

export default function QcLinkPage() {
  const { token } = useParams<{ token: string }>();
  const search = useSearchParams();
  const photoUrl = useCallback((id: string) => `/api/qc/${encodeURIComponent(token)}/photo/${id}`, [token]);

  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'error'>('loading');
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [openId, setOpenId] = useState<string | null>(search.get('report'));

  const [vin, setVin] = useState('');
  const [vinMatch, setVinMatch] = useState<{ checked: string; label: string | null } | null>(null);
  const [name, setName] = useState('');
  const [comments, setComments] = useState('');
  const [vinPhoto, setVinPhoto] = useState<Picked | null>(null);
  const [issuePhotos, setIssuePhotos] = useState<Picked[]>([]);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ emailed: string[] } | null>(null);
  const [showForm, setShowForm] = useState(true);
  const vinInput = useRef<HTMLInputElement>(null);
  const issueInput = useRef<HTMLInputElement>(null);

  useEffect(() => { setName(readName()); }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/qc/${encodeURIComponent(token)}`, { cache: 'no-store' });
      if (res.status === 404) { setState('invalid'); return; }
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setCustomerName(json.customerName || null);
      setReports(json.reports || []);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  // A link to one report (from the email) opens it under the form.
  useEffect(() => {
    const id = search.get('report');
    if (id && reports.some(r => r.id === id)) {
      setShowForm(false);
      setTimeout(() => document.getElementById(`r-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  }, [search, reports]);

  // "Do you have this vehicle?" — a quiet check line under the VIN box.
  const last6 = normalizeLast6(vin);
  useEffect(() => {
    if (!last6) { setVinMatch(null); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/qc/${encodeURIComponent(token)}?vin=${last6}`, { cache: 'no-store' });
        const json = await res.json();
        setVinMatch({ checked: last6, label: json.match?.label ?? null });
      } catch { /* the check is a nicety; the report works without it */ }
    }, 400);
    return () => clearTimeout(t);
  }, [last6, token]);

  const upload = async (file: File, kind: 'vin' | 'issue', key: string, set: (fn: (p: Picked) => Picked) => void) => {
    try {
      const small = await shrinkPhotoForUpload(file);
      const body = new FormData();
      body.append('file', small);
      body.append('kind', kind);
      const res = await fetch(`/api/qc/${encodeURIComponent(token)}/photo`, { method: 'POST', body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.id) throw new Error(json.error || 'Upload failed');
      set(p => (p.key === key ? { ...p, id: json.id } : p));
    } catch (e: any) {
      set(p => (p.key === key ? { ...p, error: e.message || 'Upload failed' } : p));
    }
  };

  const pickVin = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const key = `${Date.now()}-vin`;
    setVinPhoto({ key, preview: URL.createObjectURL(f), id: null, error: null });
    upload(f, 'vin', key, fn => setVinPhoto(p => (p ? fn(p) : p)));
  };

  const pickIssues = (files: FileList | null) => {
    const room = QC_MAX_PHOTOS - 1 - issuePhotos.length;
    const list = Array.from(files || []).slice(0, Math.max(0, room));
    const added = list.map((f, i) => ({ f, p: { key: `${Date.now()}-${i}`, preview: URL.createObjectURL(f), id: null, error: null } as Picked }));
    setIssuePhotos(prev => [...prev, ...added.map(a => a.p)]);
    for (const a of added) upload(a.f, 'issue', a.p.key, fn => setIssuePhotos(prev => prev.map(fn)));
  };

  const uploading = (vinPhoto && !vinPhoto.id && !vinPhoto.error) || issuePhotos.some(p => !p.id && !p.error);
  const goodIssues = issuePhotos.filter(p => p.id);

  const submit = async () => {
    setFormError(null);
    if (!last6) return setFormError('Enter the last 6 of the VIN.');
    if (!vinPhoto?.id) return setFormError('Add a photo of the VIN.');
    if (!goodIssues.length) return setFormError('Add at least one photo of the issue.');
    if (!name.trim()) return setFormError('Enter your name.');
    if (uploading) return setFormError('Photos are still uploading. One moment.');
    setSending(true);
    try {
      const res = await fetch(`/api/qc/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vinLast6: last6, name: name.trim(), comments: comments.trim(), vinPhotoId: vinPhoto.id, issuePhotoIds: goodIssues.map(p => p.id) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not send the report');
      saveName(name.trim());
      setSent({ emailed: json.emailed || [] });
      setVin(''); setComments(''); setVinPhoto(null); setIssuePhotos([]); setVinMatch(null);
      setShowForm(false);
      setOpenId(json.id || null);
      await load();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e: any) {
      setFormError(e.message);
    } finally {
      setSending(false);
    }
  };

  const counts = useMemo(() => ({
    open: reports.filter(r => r.status !== 'fixed').length,
  }), [reports]);

  if (state === 'loading') return <div style={page}><div style={{ ...wrap, ...muted, paddingTop: 60, textAlign: 'center' }}>Loading…</div></div>;
  if (state === 'invalid' || state === 'error') {
    return (
      <div style={page}><div style={{ ...wrap, textAlign: 'center', paddingTop: 80 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/bmg-logo-color.png" alt="BMG Fleet" style={{ height: 44, marginBottom: 24 }} />
        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>{state === 'invalid' ? 'This link no longer works' : 'Something went wrong'}</div>
        <div style={{ fontSize: 14, color: '#6b7280' }}>{state === 'invalid' ? 'Ask BMG Fleet for a new QC link.' : 'Reload the page to try again.'}</div>
      </div></div>
    );
  }

  const thumb = (src: string, onRemove?: () => void, status?: string | null) => (
    <div style={{ position: 'relative', width: 76, height: 76 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: 10, border: '1px solid #e5e7eb', opacity: status === 'uploading' ? 0.5 : 1 }} />
      {status === 'uploading' && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800 }}>Uploading…</div>}
      {status && status !== 'uploading' && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#b91c1c', background: 'rgba(255,255,255,.8)', borderRadius: 10, textAlign: 'center', padding: 4 }}>Didn&apos;t upload</div>}
      {onRemove && <button type="button" onClick={onRemove} aria-label="Remove photo" style={{ position: 'absolute', top: -7, right: -7, width: 24, height: 24, borderRadius: 12, border: 'none', background: '#111', color: '#fff', fontSize: 15, lineHeight: '24px', cursor: 'pointer', padding: 0 }}>×</button>}
    </div>
  );
  const pickedStatus = (p: Picked) => (p.error ? p.error : p.id ? null : 'uploading');

  return (
    <div style={page}>
      <div style={{ background: '#1e4a5e', color: '#fff' }}>
        <div style={{ ...wrap, padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span style={{ fontWeight: 800, fontSize: 17 }}>BMG Fleet · QC fixes</span>
          {customerName && <span style={{ fontSize: 13, opacity: 0.85, textAlign: 'right' }}>{customerName}</span>}
        </div>
      </div>
      <div style={wrap}>
        {sent && (
          <div style={{ ...card, background: '#f0fdf4', borderColor: '#bbf7d0' }}>
            <b>✓ Sent.</b> <span style={{ fontSize: 14, color: '#374151' }}>BMG has it.{sent.emailed.length ? ' A copy was emailed to your QC contacts.' : ''}</span>
          </div>
        )}

        {!showForm ? (
          <button type="button" onClick={() => { setShowForm(true); setSent(null); }} style={{ display: 'block', width: '100%', padding: 14, borderRadius: 12, border: 'none', background: '#ee3120', color: '#fff', fontWeight: 800, fontSize: 16, cursor: 'pointer', marginBottom: 12 }}>
            + Report a QC fix
          </button>
        ) : (
          <>
            <div style={card}>
              <label style={label} htmlFor="qc-vin">Last 6 of the VIN</label>
              <input id="qc-vin" value={vin} onChange={e => setVin(e.target.value.toUpperCase())} placeholder="e.g. B47213" autoCapitalize="characters" autoComplete="off" maxLength={17} style={{ ...input, letterSpacing: 1, fontWeight: 700 }} />
              {last6 && vinMatch?.checked === last6 && (
                vinMatch.label
                  ? <div style={{ fontSize: 13, color: '#15803d', fontWeight: 700, marginTop: 6 }}>✓ {vinMatch.label}</div>
                  : <div style={{ ...muted, marginTop: 6 }}>We couldn&apos;t look this one up, but you can still send it.</div>
              )}
            </div>

            <div style={card}>
              <label style={label}>Photo of the VIN</label>
              <input ref={vinInput} type="file" accept="image/*" onChange={e => { pickVin(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
              {vinPhoto
                ? thumb(vinPhoto.preview, () => setVinPhoto(null), pickedStatus(vinPhoto))
                : <button type="button" onClick={() => vinInput.current?.click()} style={dropStyle}>📷 Take or add the VIN photo</button>}
            </div>

            <div style={card}>
              <label style={label}>Photos of the issue</label>
              <input ref={issueInput} type="file" accept="image/*" multiple onChange={e => { pickIssues(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
              {issuePhotos.length < QC_MAX_PHOTOS - 1 && <button type="button" onClick={() => issueInput.current?.click()} style={dropStyle}>📷 Take or add photos</button>}
              {issuePhotos.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
                  {issuePhotos.map(p => <div key={p.key}>{thumb(p.preview, () => setIssuePhotos(prev => prev.filter(x => x.key !== p.key)), pickedStatus(p))}</div>)}
                </div>
              )}
            </div>

            <div style={card}>
              <label style={label} htmlFor="qc-comments">Comments <span style={{ fontWeight: 500, color: '#6b7280' }}>(optional)</span></label>
              <textarea id="qc-comments" value={comments} onChange={e => setComments(e.target.value)} rows={3} maxLength={4000} style={{ ...input, resize: 'vertical' }} />
              <label style={{ ...label, marginTop: 12 }} htmlFor="qc-name">Your name</label>
              <input id="qc-name" value={name} onChange={e => setName(e.target.value)} autoComplete="name" maxLength={80} style={input} />
              <div style={{ ...muted, marginTop: 6 }}>Remembered on this phone. Today&apos;s date is added for you.</div>
            </div>

            {formError && <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c', fontWeight: 700, fontSize: 14 }}>{formError}</div>}
            <button type="button" onClick={submit} disabled={sending} style={{ display: 'block', width: '100%', padding: 14, borderRadius: 12, border: 'none', background: '#ee3120', color: '#fff', fontWeight: 800, fontSize: 16, cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.7 : 1, marginBottom: 20 }}>
              {sending ? 'Sending…' : uploading ? 'Photos uploading…' : 'Send to BMG'}
            </button>
          </>
        )}

        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
            <b>Your team&apos;s reports</b>
            <span style={muted}>{counts.open} open</span>
          </div>
          {reports.length === 0 && <div style={{ ...muted, padding: '8px 0' }}>Nothing reported yet.</div>}
          {reports.map(r => {
            const open = openId === r.id;
            const firstIssue = r.photos.find(p => p.kind === 'issue') || r.photos[0];
            return (
              <div key={r.id} id={`r-${r.id}`} style={{ borderTop: '1px solid #f1f5f9', padding: '10px 0' }}>
                <button type="button" onClick={() => setOpenId(open ? null : r.id)} style={{ display: 'flex', gap: 10, alignItems: 'center', width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit', fontFamily: 'inherit' }}>
                  {firstIssue
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={photoUrl(firstIssue.id)} alt="" style={{ width: 46, height: 46, borderRadius: 8, objectFit: 'cover', flex: 'none', background: '#e5e7eb' }} />
                    : <div style={{ width: 46, height: 46, borderRadius: 8, background: '#e5e7eb', flex: 'none' }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 800 }}>…{r.vin_last6}{r.vehicle_label ? <span style={{ fontWeight: 500, color: '#6b7280' }}> · {r.vehicle_label}</span> : null}</div>
                    <div style={muted}>
                      Sent {fmtQcDate(r.created_at)}
                      {r.status === 'scheduled' && r.fix_by ? <> · fix by <b style={{ color: '#92400e' }}>{fmtQcDate(r.fix_by)}</b></> : null}
                      {r.status === 'fixed' && r.fixed_at ? <> · fixed {fmtQcDate(r.fixed_at)}</> : null}
                    </div>
                  </div>
                  <span style={{ ...CHIP[r.status], padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}>{qcStatusLabel(r.status)}</span>
                </button>
                {open && (
                  <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.5 }}>
                    <div style={muted}>Reported by {r.reported_by_name}</div>
                    {r.comments && <div style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{r.comments}</div>}
                    {r.note_to_customer && <div style={{ margin: '8px 0', padding: '8px 10px', background: '#f8fafc', borderLeft: '3px solid #1e4a5e', borderRadius: 6 }}><b>BMG:</b> {r.note_to_customer}</div>}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                      {r.photos.map(p => (
                        <a key={p.id} href={photoUrl(p.id)} target="_blank" rel="noreferrer" title={p.kind === 'vin' ? 'VIN photo' : p.kind === 'fix' ? 'Photo of the fix' : 'Issue photo'}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={photoUrl(p.id)} alt="" style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8, border: p.kind === 'fix' ? '2px solid #16a34a' : '1px solid #e5e7eb' }} />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const dropStyle: React.CSSProperties = {
  display: 'block', width: '100%', border: '2px dashed #cbd5e1', borderRadius: 12, padding: 14, background: '#fff',
  color: '#475569', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
};
