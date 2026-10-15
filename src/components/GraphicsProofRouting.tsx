'use client';

/**
 * "Rep reviews first" proofs on graphics jobs (migration 378,
 * src/lib/proof-rep-review.ts).
 *
 *   ProofRoutePicker — the "Proof goes to" switch and rep picker, used on the
 *                      new job form and the job page.
 *   ProofRouteBar    — the job page's line saying where proofs go, with
 *                      Change.
 *   RepReviewPanel   — the rep step on the job page: the artist's "Send proof
 *                      to <rep> for review", and the rep's Send to customer /
 *                      Customer approved verbally / Send back.
 */

import { useState } from 'react';
import { INTERNAL_STAFF_ROLES } from '@/lib/features';
import { canActAsRep, isRepRoute, reviewingRepId, type ProofRoute } from '@/lib/proof-rep-review-state';

export interface StaffPerson {
  id: string;
  full_name: string | null;
  email: string | null;
  role?: string | null;
  roles?: string[] | null;
}

/** BMG staff who could be a job's rep, A–Z. */
export function repOptions(people: StaffPerson[]): StaffPerson[] {
  const staff = INTERNAL_STAFF_ROLES.concat(['production']);
  return people
    .filter(p => [p.role, ...(p.roles || [])].some(r => !!r && staff.includes(r)))
    .sort((a, b) => (a.full_name || a.email || '').localeCompare(b.full_name || b.email || ''));
}

const nameIn = (people: StaffPerson[], id: string | null | undefined) => {
  const p = id ? people.find(x => x.id === id) : null;
  return p?.full_name || p?.email || null;
};
const firstOf = (name: string | null) => (name || '').trim().split(/\s+/)[0] || null;

const lbl: React.CSSProperties = {
  fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.5px', marginBottom: '6px',
};
const btn = (tone: 'blue' | 'green' | 'gray' | 'red'): React.CSSProperties => ({
  padding: '7px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
  ...(tone === 'blue' ? { background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', color: '#60a5fa' }
    : tone === 'green' ? { background: 'rgba(34,197,94,0.14)', border: '1px solid rgba(34,197,94,0.35)', color: '#22c55e' }
    : tone === 'red' ? { background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }
    : { background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)' }),
});
const textArea: React.CSSProperties = {
  width: '100%', minHeight: '64px', padding: '8px 10px', borderRadius: '8px', fontSize: '13px',
  background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-body)',
  fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box',
};

// ── Picker (new job form + job page) ────────────────────────────────────

export function ProofRoutePicker({
  route, repId, onChange, people, meId,
}: {
  route: ProofRoute;
  /** null = whoever enters the job. */
  repId: string | null;
  onChange: (route: ProofRoute, repId: string | null) => void;
  people: StaffPerson[];
  /** The person entering the job (the default rep). */
  meId: string | null;
}) {
  const options = repOptions(people);
  const choice = (value: ProofRoute, title: string, sub: string) => {
    const on = route === value;
    return (
      <button
        type="button"
        onClick={() => onChange(value, repId)}
        style={{
          flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer',
          background: on ? 'rgba(59,130,246,0.14)' : 'var(--subtle-bg)',
          border: '1px solid ' + (on ? 'rgba(59,130,246,0.6)' : 'var(--border)'),
          color: 'var(--text-body)',
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 700 }}>{on ? '✓ ' : ''}{title}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>
      </button>
    );
  };
  const selected = repId || meId || '';
  return (
    <div>
      <div style={lbl}>Proof goes to</div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {choice('customer', 'Customer', 'The artist sends the proof straight to the customer')}
        {choice('rep', 'Rep reviews first', 'The proof comes to the rep, who passes it on')}
      </div>
      {route === 'rep' && (
        <div style={{ marginTop: '10px' }}>
          <div style={lbl}>Rep</div>
          <select
            value={selected}
            onChange={e => onChange('rep', e.target.value && e.target.value !== meId ? e.target.value : null)}
            style={{
              width: '100%', padding: '9px 10px', borderRadius: '8px', fontSize: '13px',
              background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-body)',
            }}
          >
            {meId && !options.some(o => o.id === meId) && <option value={meId}>Me</option>}
            {options.map(p => (
              <option key={p.id} value={p.id}>{(p.full_name || p.email || 'Unnamed')}{p.id === meId ? ' (you)' : ''}</option>
            ))}
          </select>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Defaults to whoever enters the job. Pick someone else if you&apos;re entering it for another rep.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Shared fetch ────────────────────────────────────────────────────────

async function post(jobId: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/graphics-jobs/${jobId}/rep-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || 'Something went wrong.' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error — please try again.' };
  }
}

export interface RepReviewJobRow {
  id: string;
  created_by: string | null;
  proof_route?: string | null;
  proof_rep_id?: string | null;
  rep_review_status?: string | null;
  rep_review_proof_file_id?: string | null;
  rep_review_requested_at?: string | null;
  rep_review_requested_by?: string | null;
  rep_review_note?: string | null;
  rep_review_decided_at?: string | null;
  rep_review_decided_by?: string | null;
  rep_review_reason?: string | null;
  customer_approved?: boolean | null;
}

// ── Job page: where proofs go, with Change ──────────────────────────────

export function ProofRouteBar({
  job, people, meId, onChanged,
}: {
  job: RepReviewJobRow;
  people: StaffPerson[];
  meId: string | null;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [route, setRoute] = useState<ProofRoute>(isRepRoute(job) ? 'rep' : 'customer');
  const [repId, setRepId] = useState<string | null>(job.proof_rep_id || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repName = nameIn(people, reviewingRepId(job));
  const save = async () => {
    setBusy(true); setError(null);
    // The job's rep defaults to whoever ENTERED it, not whoever is editing.
    const r = await post(job.id, { action: 'route', route, repId: route === 'rep' ? (repId || job.created_by || meId) : job.proof_rep_id || null });
    setBusy(false);
    if (!r.ok) { setError(r.error || null); return; }
    setEditing(false);
    onChanged();
  };

  if (job.customer_approved && !editing) return null;
  return (
    <div style={{ marginBottom: '8px' }}>
      {!editing ? (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {isRepRoute(job) ? (
            <span style={{ fontWeight: 700, padding: '2px 8px', borderRadius: '10px', background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
              Rep reviews first · {repName || 'rep not set'}
            </span>
          ) : (
            <span>Proof goes straight to the customer.</span>
          )}
          <button
            type="button"
            onClick={() => { setRoute(isRepRoute(job) ? 'rep' : 'customer'); setRepId(job.proof_rep_id || job.created_by || null); setEditing(true); }}
            style={{ padding: 0, border: 'none', background: 'none', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
          >Change</button>
        </div>
      ) : (
        <div style={{ padding: '10px', borderRadius: '8px', background: 'var(--bg)', border: '1px solid var(--border)' }}>
          <ProofRoutePicker route={route} repId={repId} onChange={(r, id) => { setRoute(r); setRepId(id ?? meId); }} people={people} meId={meId} />
          {error && <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
            <button type="button" disabled={busy} onClick={save} style={btn('blue')}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" disabled={busy} onClick={() => { setEditing(false); setError(null); }} style={btn('gray')}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Job page: the rep step ──────────────────────────────────────────────

interface FileRow { id: string; file_name: string; storage_path: string; file_type?: string | null }

export function RepReviewPanel({
  job, files, people, meId, isAdmin, fileUrl, onOpenFile, onSendToCustomer, onChanged,
}: {
  job: RepReviewJobRow;
  files: FileRow[];
  people: StaffPerson[];
  meId: string | null;
  isAdmin: boolean;
  fileUrl: (f: FileRow) => string;
  onOpenFile: (e: React.MouseEvent, f: any) => void;
  /** Opens the normal customer approval email with this proof picked. */
  onSendToCustomer: (proofFileId: string | null) => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<null | 'send' | 'verbal' | 'back'>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isRepRoute(job) || job.customer_approved) return null;

  const repId = reviewingRepId(job);
  const repName = nameIn(people, repId);
  const repFirst = firstOf(repName) || 'the rep';
  const iAmRep = canActAsRep(job, meId, isAdmin);
  const pending = job.rep_review_status === 'pending';
  const artistName = nameIn(people, job.rep_review_requested_by);
  const proof = files.find(f => f.id === job.rep_review_proof_file_id) || null;

  const open = (m: 'send' | 'verbal' | 'back') => {
    setMode(m); setText(''); setError(null);
    if (m === 'send') setFileId(files[0]?.id || null);
  };
  const submit = async () => {
    setError(null);
    let body: Record<string, unknown>;
    if (mode === 'send') {
      if (!fileId) { setError('Pick a proof file to send.'); return; }
      body = { action: 'send_to_rep', proofFileId: fileId, note: text.trim() || undefined };
    } else if (mode === 'verbal') {
      if (!text.trim()) { setError('Say how the customer approved it.'); return; }
      body = { action: 'verbal_approval', note: text.trim() };
    } else {
      if (!text.trim()) { setError('Say what needs to change.'); return; }
      body = { action: 'send_back', reason: text.trim() };
    }
    setBusy(true);
    const r = await post(job.id, body);
    setBusy(false);
    if (!r.ok) { setError(r.error || null); return; }
    setMode(null);
    onChanged();
  };

  const sinceText = (iso: string | null | undefined) => {
    if (!iso) return '';
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    if (mins < 60) return `${mins}m`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
    return `${Math.round(mins / (60 * 24))}d`;
  };

  return (
    <div style={{ marginBottom: '8px' }}>
      {pending && (
        <div style={{ padding: '10px', borderRadius: '8px', border: '1px solid rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.06)', marginBottom: '8px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#fbbf24', marginBottom: '6px' }}>
            ⏱ In review with {repFirst} · {sinceText(job.rep_review_requested_at)}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {proof ? (
              <a href={fileUrl(proof)} onClick={e => onOpenFile(e, proof)} style={{ color: '#60a5fa', fontWeight: 700 }}>{proof.file_name}</a>
            ) : 'Proof file'}
            {' · sent by '}{artistName || 'the art team'}
            {job.rep_review_requested_at ? ` · ${new Date(job.rep_review_requested_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
          </div>
          {job.rep_review_note && (
            <div style={{ fontSize: '11px', color: 'var(--text-body)', fontStyle: 'italic', marginTop: '4px', whiteSpace: 'pre-wrap' }}>“{job.rep_review_note}”</div>
          )}
          {iAmRep ? (
            mode === null && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                <button type="button" onClick={() => onSendToCustomer(job.rep_review_proof_file_id || null)} style={btn('blue')}>✉ Send to customer</button>
                <button type="button" onClick={() => open('verbal')} style={btn('green')}>✓ Customer approved verbally</button>
                <button type="button" onClick={() => open('back')} style={btn('gray')}>↩ Send back to {firstOf(artistName) || 'artist'}</button>
              </div>
            )
          ) : (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
              Waiting on {repFirst}. Nothing has gone to the customer.{' '}
              {mode === null && (
                <button type="button" onClick={() => open('send')} style={{ padding: 0, border: 'none', background: 'none', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>Send a newer proof</button>
              )}
            </div>
          )}
        </div>
      )}

      {!pending && job.rep_review_status === 'changes_requested' && job.rep_review_reason && (
        <div style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.06)', marginBottom: '8px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#ef4444' }}>
            {firstOf(nameIn(people, job.rep_review_decided_by)) || repFirst} sent it back
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-body)', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>“{job.rep_review_reason}”</div>
        </div>
      )}

      {!pending && job.rep_review_status === 'sent_to_customer' && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
          {firstOf(nameIn(people, job.rep_review_decided_by)) || repFirst} reviewed it and sent it to the customer.
        </div>
      )}

      {!pending && mode === null && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {(!iAmRep || meId !== repId) && (
            <button type="button" onClick={() => open('send')} style={btn('blue')}>
              {job.rep_review_status ? 'Send new proof' : 'Send proof'} to {repFirst} for review
            </button>
          )}
          {iAmRep && (
            <button type="button" onClick={() => open('verbal')} style={btn('green')}>✓ Customer approved verbally</button>
          )}
        </div>
      )}

      {mode !== null && (
        <div style={{ padding: '10px', borderRadius: '8px', background: 'var(--bg)', border: '1px solid ' + (mode === 'verbal' ? 'rgba(34,197,94,0.4)' : 'var(--border)'), marginTop: '6px' }}>
          {mode === 'send' && (
            <>
              <div style={lbl}>Pick the proof to send to {repFirst}</div>
              {files.length === 0 ? (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '6px 0' }}>No files attached to this job. Upload a proof first.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '140px', overflowY: 'auto', marginBottom: '8px' }}>
                  {files.map(f => (
                    <label key={f.id} style={{
                      display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer',
                      background: fileId === f.id ? 'rgba(59,130,246,0.1)' : 'var(--subtle-bg)',
                      border: '1px solid ' + (fileId === f.id ? 'rgba(59,130,246,0.3)' : 'var(--border)'),
                    }}>
                      <input type="radio" checked={fileId === f.id} onChange={() => setFileId(f.id)} />
                      <span style={{ fontSize: '12px', color: 'var(--text-body)', overflowWrap: 'anywhere' }}>{f.file_name}</span>
                    </label>
                  ))}
                </div>
              )}
              <div style={lbl}>Note to {repFirst} (optional)</div>
            </>
          )}
          {mode === 'verbal' && <div style={lbl}>How did the customer approve? (required)</div>}
          {mode === 'back' && <div style={lbl}>What needs to change? (required)</div>}
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            maxLength={2000}
            placeholder={mode === 'verbal' ? 'e.g. Mike at Acme OK\'d it on the phone 10/15' : mode === 'back' ? 'e.g. Move the phone number to the rear doors' : 'Anything the rep should know'}
            style={textArea}
          />
          {mode === 'verbal' && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
              This counts as the customer&apos;s approval: production can print, and the job shows you recorded it.
            </div>
          )}
          {error && <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            <button type="button" disabled={busy} onClick={submit} style={btn(mode === 'verbal' ? 'green' : mode === 'back' ? 'red' : 'blue')}>
              {busy ? 'Saving…' : mode === 'send' ? `Send to ${repFirst}` : mode === 'verbal' ? 'Record approval' : 'Send back'}
            </button>
            <button type="button" disabled={busy} onClick={() => setMode(null)} style={btn('gray')}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
