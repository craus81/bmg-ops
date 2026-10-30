'use client';

/**
 * Requests (migration 453; Craig, 2026-10-30): anyone signed in reports a
 * problem, asks for a feature or asks a question. Claude picks new ones up
 * on a schedule and writes the answer under the request; code still waits
 * for Craig's Ship it (Waiting on Craig). Staff see everyone's requests and
 * can back one up with Me too; customer and installer accounts see their
 * own. Only Craig closes one as Won't do.
 *
 * ?id=<request> opens one (every alert links there); ?new=1 opens the form.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { readLastPage } from '@/components/LastPageTracker';
import { apiFetch } from '@/lib/api-client';
import { closeOnEscape } from '@/lib/modal-escape';
import { imageFiles, useImagesDrop } from '@/lib/use-image-drop';
import { toJpegIfHeic } from '@/lib/heic';
import {
  KIND_LABEL, MAX_REQUEST_FILES, REQUEST_KINDS, STATUS_LABEL, excerpt, isClosed, pageName,
  type AppRequestKind, type AppRequestStatus,
} from '@/lib/app-requests';

interface ListItem {
  id: string;
  number: number;
  kind: AppRequestKind;
  body: string;
  status: AppRequestStatus;
  from_page: string | null;
  submitter_name: string | null;
  mine: boolean;
  unread: boolean;
  me_too_count: number;
  i_me_too: boolean;
  created_at: string;
  updated_at: string;
}

interface Detail {
  request: ListItem & { created_by: string | null; device: string | null };
  messages: Array<{ id: string; author_kind: 'person' | 'claude'; author_id: string | null; author_name: string; body: string; created_at: string }>;
  files: Array<{ id: string; file_name: string | null; url: string }>;
  me_too: Array<{ user_id: string; name: string | null }>;
  mine: boolean;
  i_me_too: boolean;
  can_wont: boolean;
}

const GREEN = '#22c55e';
const RED = 'var(--error, #ef4444)';

const PILL: Record<AppRequestStatus, { color: string; bg: string }> = {
  new: { color: '#2563eb', bg: 'rgba(37,99,235,0.1)' },
  looking: { color: '#7c3aed', bg: 'rgba(124,58,237,0.1)' },
  waiting: { color: '#b45309', bg: 'rgba(217,119,6,0.12)' },
  done: { color: '#16a34a', bg: 'rgba(34,197,94,0.12)' },
  wont: { color: 'var(--text-muted)', bg: 'var(--subtle-bg)' },
};

function StatusPill({ status }: { status: AppRequestStatus }) {
  const c = PILL[status];
  return (
    <span style={{ padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 800, whiteSpace: 'nowrap', flexShrink: 0, color: c.color, background: c.bg, border: `1px solid ${c.color}` }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

function deviceName(): string {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  const app = /FleetSuite|Capacitor/i.test(ua) || !!(window as any).Capacitor?.isNativePlatform?.();
  const kind = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Computer';
  return app ? `${kind} app` : kind;
}

/** Phone screenshots are big PNGs: send a JPEG no wider than 2000px. */
async function shrink(picked: File): Promise<File> {
  const file = await toJpegIfHeic(picked);
  if (file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1_500_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

async function uploadScreenshot(requestId: string, f: File): Promise<string | null> {
  const file = await shrink(f);
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await apiFetch(`/api/requests/${requestId}/files`, { method: 'POST', body: form });
  if (res.ok) return null;
  const j = await res.json().catch(() => ({}));
  return j.error || `HTTP ${res.status}`;
}

export default function RequestsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { profile } = useAuth();
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [staff, setStaff] = useState(false);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [filter, setFilter] = useState<'open' | 'closed' | 'all'>('open');

  const openId = params.get('id');
  const showNew = params.get('new') === '1';

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/requests');
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setItems(j.requests || []);
      setStaff(!!j.staff);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load requests');
    }
  }, []);

  useEffect(() => { if (profile) load(); }, [profile, load]);

  const go = (q: string) => router.replace(q ? `/requests?${q}` : '/requests', { scroll: false });

  const visible = (items || [])
    .filter(r => scope === 'all' || r.mine)
    .filter(r => filter === 'all' ? true : filter === 'open' ? !isClosed(r.status) : isClosed(r.status));

  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 11px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    background: on ? 'var(--tab-active-bg)' : 'var(--subtle-bg)',
    border: `1px solid ${on ? 'var(--tab-active-border)' : 'var(--border)'}`,
    color: on ? 'var(--text-primary)' : 'var(--text-muted)',
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Requests</h1>
        <button onClick={() => go('new=1')} style={{ padding: '9px 14px', borderRadius: '10px', border: 'none', background: GREEN, color: '#fff', fontSize: '13px', fontWeight: 800, cursor: 'pointer' }}>
          + New request
        </button>
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.4 }}>
        Report a problem, ask for a feature or ask a question. Claude answers here.
      </div>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '14px 0 12px' }}>
        {staff && (
          <>
            <button style={chip(scope === 'all')} onClick={() => setScope('all')}>Everyone</button>
            <button style={chip(scope === 'mine')} onClick={() => setScope('mine')}>Mine</button>
            <span style={{ width: '8px' }} />
          </>
        )}
        <button style={chip(filter === 'open')} onClick={() => setFilter('open')}>Open</button>
        <button style={chip(filter === 'closed')} onClick={() => setFilter('closed')}>Closed</button>
        <button style={chip(filter === 'all')} onClick={() => setFilter('all')}>All</button>
      </div>

      {error && <div style={{ color: RED, fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>{error}</div>}
      {items === null && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Loading…</div>}
      {items !== null && visible.length === 0 && (
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '18px 4px', textAlign: 'center' }}>
          {items.length === 0 ? 'No requests yet. Tap + New request to send the first one.' : 'Nothing here.'}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {visible.map(r => (
          <button
            key={r.id}
            onClick={() => go(`id=${r.id}`)}
            style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left', padding: '12px', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', color: 'var(--text-primary)' }}
          >
            {r.unread && <span title="New reply" aria-label="New reply" style={{ width: '8px', height: '8px', borderRadius: '50%', background: RED, flexShrink: 0 }} />}
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{excerpt(r.body, 140)}</span>
              <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                {KIND_LABEL[r.kind]} · {r.mine ? 'You' : r.submitter_name || 'Someone'}{r.me_too_count ? ` + ${r.me_too_count} more` : ''} · {when(r.created_at)}
              </span>
            </span>
            <StatusPill status={r.status} />
          </button>
        ))}
      </div>

      {showNew && (
        <NewRequestSheet
          onClose={() => go('')}
          onSent={id => { load(); go(`id=${id}`); }}
        />
      )}
      {openId && !showNew && (
        <RequestSheet key={openId} id={openId} onClose={() => { go(''); load(); }} onChanged={load} />
      )}
    </div>
  );
}

const sheetBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' };
const sheetBox: React.CSSProperties = { width: '100%', maxWidth: '560px', maxHeight: 'calc(92vh / var(--ts))', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', display: 'flex', flexDirection: 'column' };
const sheetHead: React.CSSProperties = { position: 'sticky', top: 0, zIndex: 1, background: 'var(--card)', borderBottom: '1px solid var(--border)', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' };
const sheetFoot: React.CSSProperties = { position: 'sticky', bottom: 0, background: 'var(--card)', borderTop: '1px solid var(--border)', padding: '12px 16px', display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' };
const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' };
const textarea: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--subtle-bg)', color: 'var(--text-primary)', fontSize: '14px', lineHeight: 1.45, resize: 'vertical', fontFamily: 'inherit' };
const plainBtn: React.CSSProperties = { padding: '9px 14px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--subtle-bg)', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' };
const greenBtn: React.CSSProperties = { padding: '10px 16px', borderRadius: '10px', border: 'none', background: GREEN, color: '#fff', fontSize: '13px', fontWeight: 800, cursor: 'pointer' };

function Sheet({ title, onClose, busy, footer, children }: { title: string; onClose: () => void; busy?: boolean; footer?: React.ReactNode; children: React.ReactNode }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={closeOnEscape(busy ? undefined : onClose)} className="app-req-backdrop" style={sheetBackdrop}>
      <div role="dialog" aria-label={title} className="app-req-sheet duo-clear-status" style={sheetBox}>
        <div style={sheetHead}>
          <b style={{ fontSize: '15px', color: 'var(--text-primary)', minWidth: 0 }}>{title}</b>
          <button onClick={onClose} disabled={busy} style={plainBtn}>Close</button>
        </div>
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>{children}</div>
        {footer && <div className="app-req-foot" style={sheetFoot}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

function NewRequestSheet({ onClose, onSent }: { onClose: () => void; onSent: (id: string) => void }) {
  const [kind, setKind] = useState<AppRequestKind>('problem');
  const [text, setText] = useState('');
  const [shots, setShots] = useState<Array<{ file: File; url: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [fromPage] = useState(() => readLastPage());

  const add = (picked: File[]) => {
    const imgs = imageFiles(picked);
    if (imgs.length < picked.length) setErr('Only pictures can go on a request.');
    setShots(prev => [...prev, ...imgs.map(file => ({ file, url: URL.createObjectURL(file) }))].slice(0, MAX_REQUEST_FILES));
  };
  const { dragging, dropProps } = useImagesDrop(add, { disabled: busy });
  useEffect(() => () => { shots.forEach(s => URL.revokeObjectURL(s.url)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!text.trim()) { setErr('Type what you need before sending.'); return; }
    setBusy(true); setErr('');
    try {
      const res = await apiFetch('/api/requests', {
        method: 'POST',
        body: JSON.stringify({ kind, body: text.trim(), from_page: fromPage, device: deviceName() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const id = j.request.id as string;
      const failed: string[] = [];
      for (const s of shots) {
        const e = await uploadScreenshot(id, s.file).catch((x: any) => x?.message || 'Upload failed');
        if (e) failed.push(e);
      }
      if (failed.length) {
        // The request is saved; say so plainly and open it so they can try again there.
        alertFailedShots(failed.length, failed[0]);
      }
      onSent(id);
    } catch (e: any) {
      setErr(e?.message || 'Could not send the request');
      setBusy(false);
    }
  };

  const prompt = kind === 'problem' ? 'What happened?' : kind === 'idea' ? 'What would help?' : 'What do you want to know?';
  const placeholder = kind === 'problem' ? 'What you tapped, what you expected, what happened instead'
    : kind === 'idea' ? "What you'd like FleetSuite to do" : 'Ask anything about FleetSuite';

  return (
    <Sheet title="New request" onClose={onClose} busy={busy} footer={<button onClick={send} disabled={busy} style={{ ...greenBtn, opacity: busy ? 0.6 : 1 }}>{busy ? 'Sending…' : 'Send request'}</button>}>
      <div>
        <span style={label}>What is it?</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px' }}>
          {REQUEST_KINDS.map(k => (
            <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k} style={{
              padding: '10px 6px', borderRadius: '10px', fontSize: '13px', fontWeight: 800, cursor: 'pointer',
              border: `1px solid ${kind === k ? 'var(--tab-active-border)' : 'var(--border)'}`,
              background: kind === k ? 'var(--tab-active-bg)' : 'var(--subtle-bg)',
              color: kind === k ? 'var(--text-primary)' : 'var(--text-muted)',
            }}>{KIND_LABEL[k]}</button>
          ))}
        </div>
      </div>
      <div>
        <label htmlFor="req-text" style={label}>{prompt}</label>
        <textarea id="req-text" value={text} onChange={e => setText(e.target.value)} placeholder={placeholder} rows={5} style={textarea} autoFocus />
      </div>
      <div>
        <span style={label}>Screenshots (optional)</span>
        <div
          {...dropProps}
          onClick={() => fileRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
          style={{
            padding: '16px', borderRadius: '10px', textAlign: 'center', cursor: 'pointer',
            border: `2px dashed ${dragging ? GREEN : 'var(--border)'}`,
            background: dragging ? 'rgba(34,197,94,0.1)' : 'var(--subtle-bg)',
          }}
        >
          <div style={{ fontSize: '13px', fontWeight: 800, color: dragging ? GREEN : 'var(--text-primary)' }}>{dragging ? 'Drop to add' : '⬆ Choose screenshots'}</div>
          <div className="drop-hint" style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>or drag them here, or paste (Cmd+V)</div>
        </div>
        <input ref={fileRef} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={e => { const f = Array.from(e.target.files || []); e.target.value = ''; add(f); }} />
        {shots.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: '8px', marginTop: '8px' }}>
            {shots.map((s, i) => (
              <div key={s.url} style={{ position: 'relative', aspectRatio: '1', borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border)', background: '#fff' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt={`Screenshot ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                {!busy && (
                  <button aria-label="Remove screenshot" onClick={() => { URL.revokeObjectURL(s.url); setShots(prev => prev.filter(x => x !== s)); }}
                    style={{ position: 'absolute', top: '4px', right: '4px', width: '24px', height: '24px', borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.6)', color: '#fff', fontWeight: 900, cursor: 'pointer' }}>×</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {(fromPage || deviceName()) && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '8px 10px' }}>
          Sent from {fromPage ? <b style={{ color: 'var(--text-primary)' }}>{pageName(fromPage)}</b> : 'FleetSuite'}{deviceName() ? ` on ${deviceName()}` : ''}
        </div>
      )}
      {err && <div style={{ color: RED, fontSize: '12px', fontWeight: 700 }}>{err}</div>}
    </Sheet>
  );
}

/** Set by the form when a screenshot didn't make it; shown on the request it opens. */
let pendingShotError: string | null = null;
function alertFailedShots(n: number, first: string) {
  pendingShotError = `Your request was sent, but ${n} screenshot${n === 1 ? '' : 's'} didn't upload (${first}). Add ${n === 1 ? 'it' : 'them'} again below.`;
}

function RequestSheet({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState(() => { const e = pendingShotError; pendingShotError = null; return e || ''; });
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [wontOpen, setWontOpen] = useState(false);
  const [wontWhy, setWontWhy] = useState('');
  const [big, setBig] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/requests/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j.error || `HTTP ${res.status}`); return; }
    setD(j);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const addShots = async (picked: File[]) => {
    const imgs = imageFiles(picked);
    if (!imgs.length) return;
    setBusy(true); setErr('');
    const failed: string[] = [];
    for (const f of imgs) {
      const e = await uploadScreenshot(id, f).catch((x: any) => x?.message || 'Upload failed');
      if (e) failed.push(e);
    }
    if (failed.length) setErr(`${failed.length} screenshot${failed.length === 1 ? '' : 's'} didn't upload: ${failed[0]}`);
    await load();
    setBusy(false);
  };
  const canAdd = !!d && d.mine && d.files.length < MAX_REQUEST_FILES;
  const { dragging, dropProps } = useImagesDrop(addShots, { disabled: busy || !canAdd, pasteEnabled: canAdd });

  const sendReply = async () => {
    if (!reply.trim()) { setErr('Type a reply before sending.'); return; }
    setBusy(true); setErr('');
    const res = await apiFetch(`/api/requests/${id}/messages`, { method: 'POST', body: JSON.stringify({ body: reply.trim() }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error || `HTTP ${res.status}`); return; }
    setReply('');
    await load();
    onChanged();
  };

  const toggleMeToo = async () => {
    if (!d) return;
    setBusy(true); setErr('');
    const res = await apiFetch(`/api/requests/${id}/me-too`, { method: 'POST', body: JSON.stringify({ on: !d.i_me_too }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error || `HTTP ${res.status}`); return; }
    await load();
    onChanged();
  };

  const saveWont = async () => {
    if (!wontWhy.trim()) { setErr('Add a reason so the person who asked knows why.'); return; }
    setBusy(true); setErr('');
    const res = await apiFetch(`/api/requests/${id}/wont`, { method: 'POST', body: JSON.stringify({ reason: wontWhy.trim() }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error || `HTTP ${res.status}`); return; }
    setWontOpen(false); setWontWhy('');
    await load();
    onChanged();
  };

  const r = d?.request;
  const title = r ? `${KIND_LABEL[r.kind]} #${r.number}` : 'Request';
  const backers = d ? d.me_too.map(m => m.name || 'Someone') : [];

  return (
    <Sheet title={title} onClose={onClose} busy={busy} footer={d && <button onClick={sendReply} disabled={busy} style={{ ...greenBtn, opacity: busy ? 0.6 : 1 }}>Send reply</button>}>
      {!d && !err && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Loading…</div>}
      {d && r && (
        <>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', fontSize: '11px', color: 'var(--text-muted)' }}>
            <StatusPill status={r.status} />
            {r.from_page && <span>from {pageName(r.from_page)}</span>}
            {r.device && <span>· {r.device}</span>}
          </div>
          <Message name={d.mine ? 'You' : r.submitter_name || 'Someone'} at={r.created_at} body={r.body} />

          {d.files.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '8px' }}>
              {d.files.map((f, i) => (
                <button key={f.id} onClick={() => setBig(f.url)} aria-label={`Open screenshot ${i + 1}`} style={{ aspectRatio: '1', borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border)', background: '#fff', padding: 0, cursor: 'zoom-in' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.url} alt={f.file_name || `Screenshot ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                </button>
              ))}
            </div>
          )}
          {canAdd && (
            <div {...dropProps} onClick={() => fileRef.current?.click()} role="button" tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
              style={{ padding: '10px', borderRadius: '10px', textAlign: 'center', cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: dragging ? GREEN : 'var(--text-muted)', border: `2px dashed ${dragging ? GREEN : 'var(--border)'}`, background: dragging ? 'rgba(34,197,94,0.1)' : 'transparent' }}>
              {dragging ? 'Drop to add' : '⬆ Add a screenshot'}<span className="drop-hint"> · drag or paste</span>
              <input ref={fileRef} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={e => { const f = Array.from(e.target.files || []); e.target.value = ''; addShots(f); }} />
            </div>
          )}

          {!d.mine && d.request.created_by !== null && (
            <div>
              <button onClick={toggleMeToo} disabled={busy} aria-pressed={d.i_me_too} style={{
                ...plainBtn,
                ...(d.i_me_too ? { background: 'rgba(34,197,94,0.12)', borderColor: GREEN, color: '#16a34a' } : {}),
              }}>{d.i_me_too ? '✓ ' : ''}Me too{backers.length ? ` · ${backers.length}` : ''}</button>
            </div>
          )}
          {backers.length > 0 && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Also wanted by {backers.join(', ')}</div>
          )}

          {d.messages.map(m => (
            <Message key={m.id} name={m.author_kind === 'claude' ? 'Claude' : m.author_name} at={m.created_at} body={m.body} claude={m.author_kind === 'claude'} />
          ))}

          <div>
            <label htmlFor="req-reply" style={label}>Add a reply</label>
            <textarea id="req-reply" value={reply} onChange={e => setReply(e.target.value)} rows={3} style={textarea}
              placeholder={isClosed(r.status) ? "Not quite right? Say what's still wrong and it reopens" : 'More detail, or a question'} />
          </div>

          {d.can_wont && r.status !== 'wont' && (
            <div style={{ borderTop: '1px dashed var(--border)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {wontOpen ? (
                <>
                  <label htmlFor="req-wont" style={label}>Why won&apos;t we do it?</label>
                  <textarea id="req-wont" value={wontWhy} onChange={e => setWontWhy(e.target.value)} rows={3} style={textarea} placeholder="The person who asked sees this" />
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button onClick={() => { setWontOpen(false); setWontWhy(''); }} disabled={busy} style={plainBtn}>Cancel</button>
                    <button onClick={saveWont} disabled={busy} style={greenBtn}>Save</button>
                  </div>
                </>
              ) : (
                <div><button onClick={() => setWontOpen(true)} style={plainBtn}>Won&apos;t do…</button></div>
              )}
            </div>
          )}
        </>
      )}
      {err && <div style={{ color: RED, fontSize: '12px', fontWeight: 700 }}>{err}</div>}
      {big && typeof document !== 'undefined' && createPortal(
        <div onClick={() => setBig(null)} ref={closeOnEscape(() => setBig(null))} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px', cursor: 'zoom-out' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={big} alt="Screenshot" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>,
        document.body,
      )}
    </Sheet>
  );
}

function Message({ name, at, body, claude }: { name: string; at: string; body: string; claude?: boolean }) {
  return (
    <div style={{
      borderRadius: '12px', padding: '10px 12px', fontSize: '13px', lineHeight: 1.5,
      border: `1px solid ${claude ? '#7c3aed' : 'var(--border)'}`,
      background: claude ? 'rgba(124,58,237,0.08)' : 'var(--subtle-bg)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
        <b style={{ color: 'var(--text-primary)', fontSize: '12px' }}>{name}</b>
        <span>{when(at)}</span>
      </div>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-primary)' }}>{body}</div>
    </div>
  );
}
